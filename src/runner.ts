import { compileWorkflow, type CompiledWorkflow } from "./workflow.js";
import type {
  EdgeState,
  Handlers,
  NodeInput,
  NodeSnapshot,
  NodeState,
  ReviewTaskSnapshot,
  RunSnapshot,
  RunnerOptions,
  RunStatus,
  WorkflowDef,
} from "./types.js";

export interface StartRunResult {
  runId: string;
}

export interface SubmitReviewResult {
  accepted: boolean;
  reason?: string;
}

const LOW_CONFIDENCE_THRESHOLD = 70;
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 32000];

interface ReviewTaskRecord {
  id: string;
  nodeId: string;
  status: "pending" | "resolved";
  originalOutput: unknown;
  confidence: number;
  correction?: unknown;
}

interface RunRecord {
  id: string;
  workflow: CompiledWorkflow;
  handlers: Handlers;
  entryInput: NodeInput;
  status: RunStatus;
  error?: string;
  nodeStates: Map<string, NodeState>;
  nodeOutputs: Map<string, unknown>;
  nodeAttempts: Map<string, number>;
  nodeLastError: Map<string, string>;
  edgeStates: Map<string, EdgeState>;
  reviewTasks: ReviewTaskRecord[];
  settleListeners: Array<() => void>;
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/** 文档工作流运行库：状态全部保存在内存中 */
export class WorkflowRunner {
  private readonly retryDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly runs = new Map<string, RunRecord>();
  private runCounter = 0;
  private taskCounter = 0;

  constructor(options?: RunnerOptions) {
    this.retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep =
      options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** 启动一次文档运行 */
  startRun(workflow: WorkflowDef, handlers: Handlers, input: NodeInput): StartRunResult {
    const compiled = compileWorkflow(workflow);
    const runId = `run-${++this.runCounter}`;
    const record: RunRecord = {
      id: runId,
      workflow: compiled,
      handlers,
      entryInput: input,
      status: "running",
      nodeStates: new Map(compiled.nodeIds.map((id) => [id, "pending"])),
      nodeOutputs: new Map(),
      nodeAttempts: new Map(compiled.nodeIds.map((id) => [id, 0])),
      nodeLastError: new Map(),
      edgeStates: new Map(),
      reviewTasks: [],
      settleListeners: [],
    };
    for (const edge of workflow.edges) {
      record.edgeStates.set(edgeKey(edge.from, edge.to), "undetermined");
    }
    this.runs.set(runId, record);
    // 入口节点没有入边，视为入边已全部确定，立即参与决策
    this.maybeDecide(record, compiled.def.entry);
    return { runId };
  }

  /** 提交复核结果；首个提交生效，重复/冲突提交不覆盖 */
  submitReview(runId: string, taskId: string, correction: unknown): SubmitReviewResult {
    const record = this.runs.get(runId);
    if (!record) {
      return { accepted: false, reason: `run not found: ${runId}` };
    }
    const task = record.reviewTasks.find((t) => t.id === taskId);
    if (!task) {
      return { accepted: false, reason: `review task not found: ${taskId}` };
    }
    if (record.status !== "running") {
      return { accepted: false, reason: `run is ${record.status}` };
    }
    if (task.status !== "pending") {
      return { accepted: false, reason: "review task already resolved" };
    }
    task.status = "resolved";
    task.correction = correction;
    const nodeId = task.nodeId;
    // 修正字段整体替代原结果，节点成功并发布输出
    record.nodeOutputs.set(nodeId, correction);
    record.nodeStates.set(nodeId, "succeeded");
    this.publishOutgoing(record, nodeId, null);
    this.checkCompletion(record);
    return { accepted: true };
  }

  /** 读取运行快照（含复核任务） */
  getRunSnapshot(runId: string): RunSnapshot {
    const record = this.runs.get(runId);
    if (!record) {
      throw new Error(`run not found: ${runId}`);
    }
    const nodes: NodeSnapshot[] = record.workflow.nodeIds.map((id) => {
      const snap: NodeSnapshot = {
        id,
        kind: record.workflow.def.nodes.find((n) => n.id === id)!.kind,
        state: record.nodeStates.get(id)!,
        attempts: record.nodeAttempts.get(id)!,
      };
      if (record.nodeOutputs.has(id)) {
        snap.output = record.nodeOutputs.get(id);
      }
      const lastError = record.nodeLastError.get(id);
      if (lastError !== undefined) {
        snap.lastError = lastError;
      }
      return snap;
    });
    const edges = record.workflow.def.edges.map((e) => ({
      from: e.from,
      to: e.to,
      state: record.edgeStates.get(edgeKey(e.from, e.to))!,
    }));
    const reviewTasks: ReviewTaskSnapshot[] = record.reviewTasks.map((t) => {
      const snap: ReviewTaskSnapshot = {
        id: t.id,
        nodeId: t.nodeId,
        status: t.status,
        originalOutput: t.originalOutput,
        confidence: t.confidence,
      };
      if (t.status === "resolved") {
        snap.correction = t.correction;
      }
      return snap;
    });
    const snapshot: RunSnapshot = {
      id: record.id,
      status: record.status,
      nodes,
      edges,
      reviewTasks,
    };
    if (record.error !== undefined) {
      snapshot.error = record.error;
    }
    return snapshot;
  }

  /** 等待运行进入终态（succeeded / failed），返回最终快照 */
  whenSettled(runId: string): Promise<RunSnapshot> {
    const record = this.runs.get(runId);
    if (!record) {
      return Promise.reject(new Error(`run not found: ${runId}`));
    }
    if (record.status !== "running") {
      return Promise.resolve(this.getRunSnapshot(runId));
    }
    return new Promise((resolve) => {
      record.settleListeners.push(() => resolve(this.getRunSnapshot(runId)));
    });
  }

  /** 入边全部确定后决定节点执行还是跳过 */
  private maybeDecide(record: RunRecord, nodeId: string): void {
    if (record.status !== "running") {
      return;
    }
    if (record.nodeStates.get(nodeId) !== "pending") {
      return;
    }
    const incoming = record.workflow.incoming.get(nodeId)!;
    let selected = 0;
    for (const from of incoming) {
      const state = record.edgeStates.get(edgeKey(from, nodeId))!;
      if (state === "undetermined") {
        return; // 仍有入边未确定，不能提前决定
      }
      if (state === "selected") {
        selected += 1;
      }
    }
    if (incoming.length === 0 || selected > 0) {
      record.nodeStates.set(nodeId, "ready");
      void this.executeNode(record, nodeId);
    } else {
      // 全部入边被排除：跳过，出边全部排除
      record.nodeStates.set(nodeId, "skipped");
      for (const to of record.workflow.outgoing.get(nodeId)!) {
        record.edgeStates.set(edgeKey(nodeId, to), "excluded");
      }
      for (const to of record.workflow.outgoing.get(nodeId)!) {
        this.maybeDecide(record, to);
      }
      this.checkCompletion(record);
    }
  }

  private async executeNode(record: RunRecord, nodeId: string): Promise<void> {
    const kind = record.workflow.def.nodes.find((n) => n.id === nodeId)!.kind;
    const handler =
      kind === "process"
        ? record.handlers.process?.[nodeId]
        : record.handlers.condition?.[nodeId];
    if (!handler) {
      this.failRun(record, nodeId, new Error(`no handler registered for node: ${nodeId}`));
      return;
    }
    const input = this.buildInput(record, nodeId);
    for (;;) {
      if (record.status !== "running") {
        return; // 运行已终止，不再启动新步骤
      }
      record.nodeAttempts.set(nodeId, record.nodeAttempts.get(nodeId)! + 1);
      try {
        const result = await handler(input);
        this.onHandlerSuccess(record, nodeId, kind, result);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        record.nodeLastError.set(nodeId, message);
        const attempts = record.nodeAttempts.get(nodeId)!;
        if (attempts > this.retryDelaysMs.length || record.status !== "running") {
          if (record.status === "running") {
            this.failRun(record, nodeId, err);
          }
          return;
        }
        await this.sleep(this.retryDelaysMs[attempts - 1]);
      }
    }
  }

  private onHandlerSuccess(
    record: RunRecord,
    nodeId: string,
    kind: "process" | "condition",
    result: unknown,
  ): void {
    if (record.status !== "running") {
      return; // 迟到结果不得重新激活节点
    }
    if (record.nodeStates.get(nodeId) !== "ready") {
      return;
    }
    if (kind === "process") {
      const { output, confidence } = result as { output: unknown; confidence?: number };
      if (confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD) {
        // 低置信度：生成复核任务，结果暂不发布，节点仍未完成
        record.reviewTasks.push({
          id: `review-${++this.taskCounter}`,
          nodeId,
          status: "pending",
          originalOutput: output,
          confidence,
        });
        record.nodeStates.set(nodeId, "awaiting_review");
        return;
      }
      record.nodeOutputs.set(nodeId, output);
      record.nodeStates.set(nodeId, "succeeded");
      // 普通节点成功后选择全部出边
      this.publishOutgoing(record, nodeId, null);
    } else {
      const { output, select } = result as { output?: unknown; select: string[] };
      const successors = new Set(record.workflow.outgoing.get(nodeId)!);
      const chosen = new Set(select ?? []);
      for (const to of chosen) {
        if (!successors.has(to)) {
          this.failRun(record, nodeId, new Error(`condition node ${nodeId} selected non-successor: ${to}`));
          return;
        }
      }
      record.nodeOutputs.set(nodeId, output);
      record.nodeStates.set(nodeId, "succeeded");
      this.publishOutgoing(record, nodeId, chosen);
    }
    this.checkCompletion(record);
  }

  /** 发布出边：普通节点全选；条件节点按 chosen 子集选择，其余排除 */
  private publishOutgoing(record: RunRecord, nodeId: string, chosen: Set<string> | null): void {
    const outgoing = record.workflow.outgoing.get(nodeId)!;
    for (const to of outgoing) {
      const state = chosen === null ? "selected" : chosen.has(to) ? "selected" : "excluded";
      record.edgeStates.set(edgeKey(nodeId, to), state);
    }
    for (const to of outgoing) {
      this.maybeDecide(record, to);
    }
  }

  private buildInput(record: RunRecord, nodeId: string): NodeInput {
    if (nodeId === record.workflow.def.entry) {
      return record.entryInput;
    }
    const input: NodeInput = {};
    for (const from of record.workflow.incoming.get(nodeId)!) {
      if (record.edgeStates.get(edgeKey(from, nodeId)) === "selected") {
        input[from] = record.nodeOutputs.get(from);
      }
    }
    return input;
  }

  private failRun(record: RunRecord, nodeId: string, err: unknown): void {
    if (record.status !== "running") {
      return;
    }
    record.nodeStates.set(nodeId, "failed");
    record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
    this.notifySettled(record);
  }

  private checkCompletion(record: RunRecord): void {
    if (record.status !== "running") {
      return;
    }
    for (const id of record.workflow.nodeIds) {
      const state = record.nodeStates.get(id)!;
      if (state !== "succeeded" && state !== "skipped") {
        return;
      }
    }
    record.status = "succeeded";
    this.notifySettled(record);
  }

  private notifySettled(record: RunRecord): void {
    const listeners = record.settleListeners.splice(0);
    for (const listener of listeners) {
      listener();
    }
  }
}
