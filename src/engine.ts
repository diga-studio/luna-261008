import type {
  EdgeStatus,
  Handler,
  Handlers,
  JsonObject,
  NodeStatus,
  NodeType,
  ReviewTaskSnapshot,
  RunSnapshot,
  RunStatus,
  Workflow,
} from "./types.js";

export const REVIEW_CONFIDENCE_THRESHOLD = 70;
const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 32000];

export interface WorkflowEngineOptions {
  retryDelaysMs?: number[];
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

interface NodeState {
  id: string;
  type: NodeType;
  status: NodeStatus;
  attempts: number;
  output?: JsonObject;
  input?: JsonObject;
  retryToken: number;
}

interface EdgeState {
  from: string;
  to: string;
  status: EdgeStatus;
}

interface ReviewTaskState {
  taskId: string;
  nodeId: string;
  status: "pending" | "resolved";
  originalOutput: JsonObject;
  confidence: number;
  correctedOutput?: JsonObject;
}

interface RunState {
  runId: string;
  status: RunStatus;
  error?: string;
  entry: string;
  nodes: Map<string, NodeState>;
  edges: EdgeState[];
  inEdges: Map<string, EdgeState[]>;
  outEdges: Map<string, EdgeState[]>;
  reviewTasks: Map<string, ReviewTaskState>;
  reviewTaskSeq: number;
}

export class WorkflowEngine {
  private readonly handlers: Handlers;
  private readonly retryDelaysMs: number[];
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly runs = new Map<string, RunState>();
  private runSeq = 0;

  constructor(handlers: Handlers, options?: WorkflowEngineOptions) {
    this.handlers = handlers;
    this.retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.setTimeoutFn =
      options?.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  }

  startRun(workflow: Workflow, fields: JsonObject): string {
    const nodes = new Map<string, NodeState>();
    for (const n of workflow.nodes) {
      if (nodes.has(n.id)) {
        throw new Error(`duplicate node id: ${n.id}`);
      }
      nodes.set(n.id, {
        id: n.id,
        type: n.type,
        status: "pending",
        attempts: 0,
        retryToken: 0,
      });
    }
    if (!nodes.has(workflow.entry)) {
      throw new Error(`entry node not found: ${workflow.entry}`);
    }
    const edges: EdgeState[] = workflow.edges.map((e) => {
      if (!nodes.has(e.from) || !nodes.has(e.to)) {
        throw new Error(`edge references unknown node: ${e.from} -> ${e.to}`);
      }
      return { from: e.from, to: e.to, status: "undetermined" };
    });
    const inEdges = new Map<string, EdgeState[]>();
    const outEdges = new Map<string, EdgeState[]>();
    for (const e of edges) {
      if (!inEdges.has(e.to)) inEdges.set(e.to, []);
      inEdges.get(e.to)!.push(e);
      if (!outEdges.has(e.from)) outEdges.set(e.from, []);
      outEdges.get(e.from)!.push(e);
    }
    const runId = `run_${++this.runSeq}`;
    const run: RunState = {
      runId,
      status: "running",
      entry: workflow.entry,
      nodes,
      edges,
      inEdges,
      outEdges,
      reviewTasks: new Map(),
      reviewTaskSeq: 0,
    };
    this.runs.set(runId, run);
    this.executeNode(run, workflow.entry, { ...fields });
    this.advance(run);
    return runId;
  }

  submitReview(runId: string, taskId: string, corrected: JsonObject): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return false;
    const task = run.reviewTasks.get(taskId);
    if (!task || task.status !== "pending") return false;
    const node = run.nodes.get(task.nodeId);
    if (!node || node.status !== "awaiting_review") return false;

    task.status = "resolved";
    task.correctedOutput = { ...corrected };
    node.output = { ...corrected };
    node.status = "succeeded";
    for (const e of run.outEdges.get(node.id) ?? []) {
      e.status = "selected";
    }
    this.advance(run);
    return true;
  }

  getSnapshot(runId: string): RunSnapshot {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`run not found: ${runId}`);
    }
    const reviewTasks: ReviewTaskSnapshot[] = [];
    for (const t of run.reviewTasks.values()) {
      reviewTasks.push({
        taskId: t.taskId,
        nodeId: t.nodeId,
        status: t.status,
        originalOutput: { ...t.originalOutput },
        confidence: t.confidence,
        correctedOutput: t.correctedOutput
          ? { ...t.correctedOutput }
          : undefined,
      });
    }
    return {
      runId: run.runId,
      status: run.status,
      error: run.error,
      nodes: [...run.nodes.values()].map((n) => ({
        nodeId: n.id,
        type: n.type,
        status: n.status,
        attempts: n.attempts,
        output: n.output ? { ...n.output } : undefined,
      })),
      edges: run.edges.map((e) => ({ ...e })),
      reviewTasks,
    };
  }

  private handlerFor(node: NodeState): Handler {
    const table =
      node.type === "condition" ? this.handlers.condition : this.handlers.process;
    const handler = table?.[node.id];
    if (!handler) {
      throw new Error(`no handler registered for node: ${node.id}`);
    }
    return handler;
  }

  private executeNode(run: RunState, nodeId: string, input: JsonObject): void {
    const node = run.nodes.get(nodeId)!;
    node.status = "running";
    node.attempts += 1;
    node.input = input;
    const attempt = node.attempts;
    let handler: Handler;
    try {
      handler = this.handlerFor(node);
    } catch (err) {
      this.handleFailure(run, node, err);
      return;
    }
    Promise.resolve()
      .then(() =>
        handler({ ...input }, { runId: run.runId, nodeId, attempt }),
      )
      .then(
        (result) => this.handleSuccess(run, node, result ?? {}),
        (err) => this.handleFailure(run, node, err),
      );
  }

  private handleSuccess(
    run: RunState,
    node: NodeState,
    result: { output?: JsonObject; confidence?: number; select?: string[] },
  ): void {
    if (run.status !== "running" || node.status !== "running") return;
    const output = result.output ?? {};
    if (node.type === "condition") {
      const outEdges = run.outEdges.get(node.id) ?? [];
      const validTargets = new Set(outEdges.map((e) => e.to));
      const select = result.select ?? [];
      for (const target of select) {
        if (!validTargets.has(target)) {
          this.handleFailure(
            run,
            node,
            new Error(`condition selected unknown successor: ${target}`),
          );
          return;
        }
      }
      const selected = new Set(select);
      node.output = output;
      node.status = "succeeded";
      for (const e of outEdges) {
        e.status = selected.has(e.to) ? "selected" : "excluded";
      }
    } else {
      const confidence = result.confidence;
      if (
        confidence !== undefined &&
        confidence < REVIEW_CONFIDENCE_THRESHOLD
      ) {
        const taskId = `task_${run.runId}_${++run.reviewTaskSeq}`;
        run.reviewTasks.set(taskId, {
          taskId,
          nodeId: node.id,
          status: "pending",
          originalOutput: { ...output },
          confidence,
        });
        node.status = "awaiting_review";
        return;
      }
      node.output = output;
      node.status = "succeeded";
      for (const e of run.outEdges.get(node.id) ?? []) {
        e.status = "selected";
      }
    }
    this.advance(run);
  }

  private handleFailure(run: RunState, node: NodeState, err: unknown): void {
    if (run.status !== "running") return;
    if (node.status !== "running") return;
    const message = err instanceof Error ? err.message : String(err);
    if (node.attempts > this.retryDelaysMs.length) {
      run.status = "failed";
      run.error = `node ${node.id} failed after ${node.attempts} attempts: ${message}`;
      return;
    }
    node.status = "waiting_retry";
    const delay = this.retryDelaysMs[node.attempts - 1];
    const token = ++node.retryToken;
    const input = node.input ?? {};
    this.setTimeoutFn(() => {
      if (run.status !== "running") return;
      if (node.status !== "waiting_retry" || node.retryToken !== token) return;
      this.executeNode(run, node.id, input);
      this.advance(run);
    }, delay);
  }

  private advance(run: RunState): void {
    if (run.status !== "running") return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const node of run.nodes.values()) {
        if (node.status !== "pending") continue;
        if (node.id === run.entry) continue;
        const ins = run.inEdges.get(node.id) ?? [];
        if (ins.some((e) => e.status === "undetermined")) continue;
        const selected = ins.filter((e) => e.status === "selected");
        if (selected.length === 0) {
          node.status = "skipped";
          for (const e of run.outEdges.get(node.id) ?? []) {
            e.status = "excluded";
          }
        } else {
          const input: JsonObject = {};
          for (const e of selected) {
            const up = run.nodes.get(e.from)!;
            Object.assign(input, up.output);
          }
          this.executeNode(run, node.id, input);
        }
        progressed = true;
      }
    }
    if (run.status !== "running") return;
    for (const node of run.nodes.values()) {
      if (node.status !== "succeeded" && node.status !== "skipped") return;
    }
    run.status = "succeeded";
  }
}
