import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "../src/index.js";
import type {
  Handler,
  HandlerResult,
  JsonObject,
  Workflow,
} from "../src/index.js";

async function settle(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

function recorder() {
  const calls: Record<string, JsonObject[]> = {};
  const record = (id: string, input: JsonObject) => {
    if (!calls[id]) calls[id] = [];
    calls[id].push(input);
  };
  return { calls, record };
}

function nodeStatuses(snapshot: {
  nodes: { nodeId: string; status: string }[];
}): Record<string, string> {
  return Object.fromEntries(
    snapshot.nodes.map((n) => [n.nodeId, n.status]),
  );
}

describe("分支/汇合拓扑规则", () => {
  const workflow: Workflow = {
    entry: "entry",
    nodes: [
      { id: "entry", type: "process" },
      { id: "A", type: "condition" },
      { id: "B", type: "condition" },
      { id: "C", type: "process" },
      { id: "D", type: "process" },
      { id: "E", type: "process" },
      { id: "F", type: "process" },
      { id: "G", type: "process" },
      { id: "H", type: "process" },
      { id: "J", type: "process" },
    ],
    edges: [
      { from: "entry", to: "A" },
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "B", to: "E" },
      { from: "C", to: "F" },
      { from: "D", to: "G" },
      { from: "F", to: "G" },
      { from: "E", to: "H" },
      { from: "G", to: "J" },
      { from: "H", to: "J" },
    ],
  };

  function makeEngine(
    rec: ReturnType<typeof recorder>,
    bSelect: string[],
  ): WorkflowEngine {
    const processHandler =
      (id: string): Handler =>
      async (input) => {
        rec.record(id, input);
        return { output: { [id]: true } };
      };
    return new WorkflowEngine({
      process: {
        entry: processHandler("entry"),
        C: processHandler("C"),
        D: processHandler("D"),
        E: processHandler("E"),
        F: processHandler("F"),
        G: processHandler("G"),
        H: processHandler("H"),
        J: processHandler("J"),
      },
      condition: {
        A: async (input) => {
          rec.record("A", input);
          return { output: { A: true }, select: ["B", "C"] };
        },
        B: async (input) => {
          rec.record("B", input);
          return { output: { B: true }, select: bSelect };
        },
      },
    });
  }

  it("嵌套分流 + 共享后继双路激活 + 单入边排除导致跳过", async () => {
    const rec = recorder();
    const engine = makeEngine(rec, ["D"]);
    const runId = engine.startRun(workflow, { doc: "x" });
    await settle();

    const snapshot = engine.getSnapshot(runId);
    expect(snapshot.status).toBe("succeeded");
    expect(nodeStatuses(snapshot)).toEqual({
      entry: "succeeded",
      A: "succeeded",
      B: "succeeded",
      C: "succeeded",
      D: "succeeded",
      E: "skipped",
      F: "succeeded",
      G: "succeeded",
      H: "skipped",
      J: "succeeded",
    });

    // 未选中的分支不执行
    expect(rec.calls.E).toBeUndefined();
    expect(rec.calls.H).toBeUndefined();
    // 每个已执行节点恰好执行一次
    for (const id of ["entry", "A", "B", "C", "D", "F", "G", "J"]) {
      expect(rec.calls[id]).toHaveLength(1);
    }
    // 入口接收文档字段
    expect(rec.calls.entry[0]).toEqual({ doc: "x" });
    // 共享后继 G 等到 D、F 都完成后汇合两者输出
    expect(rec.calls.G[0]).toEqual({ D: true, F: true });
    // J 只收到被选中前驱 G 的输出，被跳过的 H 不参与
    expect(rec.calls.J[0]).toEqual({ G: true });

    const edgeStatus = Object.fromEntries(
      snapshot.edges.map((e) => [`${e.from}->${e.to}`, e.status]),
    );
    expect(edgeStatus["B->E"]).toBe("excluded");
    expect(edgeStatus["E->H"]).toBe("excluded");
    expect(edgeStatus["H->J"]).toBe("excluded");
    expect(edgeStatus["D->G"]).toBe("selected");
    expect(edgeStatus["F->G"]).toBe("selected");
    expect(edgeStatus["G->J"]).toBe("selected");
  });

  it("条件节点选择空集：下游全部排除，共享后继仍被其他路径激活", async () => {
    const rec = recorder();
    const engine = makeEngine(rec, []);
    const runId = engine.startRun(workflow, { doc: "y" });
    await settle();

    const snapshot = engine.getSnapshot(runId);
    expect(snapshot.status).toBe("succeeded");
    const statuses = nodeStatuses(snapshot);
    // B 选择了空集，B 的下游全部因入边全排除而跳过
    expect(statuses.D).toBe("skipped");
    expect(statuses.E).toBe("skipped");
    expect(statuses.H).toBe("skipped");
    // 共享后继 G 仍被 C->F 路径激活，且输入只含 F 的输出
    expect(statuses.G).toBe("succeeded");
    expect(rec.calls.G[0]).toEqual({ F: true });
    expect(rec.calls.J[0]).toEqual({ G: true });
    // 跳过节点没有输出
    const dNode = snapshot.nodes.find((n) => n.nodeId === "D")!;
    expect(dNode.output).toBeUndefined();
  });
});

describe("低置信度复核与重试", () => {
  const workflow: Workflow = {
    entry: "entry",
    nodes: [
      { id: "entry", type: "process" },
      { id: "P", type: "process" },
      { id: "Q", type: "process" },
      { id: "R", type: "process" },
      { id: "J", type: "process" },
    ],
    edges: [
      { from: "entry", to: "P" },
      { from: "entry", to: "Q" },
      { from: "entry", to: "R" },
      { from: "P", to: "J" },
      { from: "Q", to: "J" },
      { from: "R", to: "J" },
    ],
  };

  it("复核不阻塞无关分支，重复提交只推进一次，置信度70直接通过", async () => {
    const rec = recorder();
    let qAttempts = 0;
    const engine = new WorkflowEngine(
      {
        process: {
          entry: async () => ({ output: { doc: 1 } }),
          P: async () => ({ output: { p: "raw" }, confidence: 50 }),
          Q: async () => {
            qAttempts += 1;
            if (qAttempts < 3) {
              throw new Error(`Q transient failure ${qAttempts}`);
            }
            rec.record("Q", {});
            return { output: { q: 1 } };
          },
          R: async () => {
            rec.record("R", {});
            return { output: { r: 1 }, confidence: 70 };
          },
          J: async (input) => {
            rec.record("J", input);
            return { output: { done: true } };
          },
        },
      },
      { retryDelaysMs: [5, 10, 20] },
    );

    const runId = engine.startRun(workflow, { doc: 1 });

    // 等待 Q 重试成功、R 直接通过；期间 P 处于待复核
    await vi.waitFor(() => {
      const s = engine.getSnapshot(runId);
      expect(nodeStatuses(s).Q).toBe("succeeded");
    });
    let snapshot = engine.getSnapshot(runId);
    let statuses = nodeStatuses(snapshot);
    expect(statuses.P).toBe("awaiting_review");
    expect(statuses.R).toBe("succeeded");
    // 复核未阻塞汇合前的其他分支，但汇合 J 必须等 P 的出边确定
    expect(statuses.J).toBe("pending");
    expect(rec.calls.J).toBeUndefined();
    expect(qAttempts).toBe(3);

    // 生成了一个复核任务，原结果未发布
    expect(snapshot.reviewTasks).toHaveLength(1);
    const task = snapshot.reviewTasks[0];
    expect(task.nodeId).toBe("P");
    expect(task.status).toBe("pending");
    expect(task.confidence).toBe(50);
    expect(task.originalOutput).toEqual({ p: "raw" });
    expect(
      snapshot.nodes.find((n) => n.nodeId === "P")!.output,
    ).toBeUndefined();

    // 错误任务 id 提交无效
    expect(engine.submitReview(runId, "task_nope", { p: "x" })).toBe(false);

    // 首个提交生效：修正字段整体替代原结果，推进后继
    expect(engine.submitReview(runId, task.taskId, { p: "fixed" })).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(engine.getSnapshot(runId).status).toBe("succeeded");
    });
    expect(rec.calls.J).toHaveLength(1);
    expect(rec.calls.J[0]).toEqual({ p: "fixed", q: 1, r: 1 });

    // 重复/冲突提交不得覆盖，也不得再次推进后继
    expect(engine.submitReview(runId, task.taskId, { p: "evil" })).toBe(
      false,
    );
    await settle();
    snapshot = engine.getSnapshot(runId);
    expect(snapshot.nodes.find((n) => n.nodeId === "P")!.output).toEqual({
      p: "fixed",
    });
    expect(snapshot.reviewTasks[0].correctedOutput).toEqual({ p: "fixed" });
    expect(rec.calls.J).toHaveLength(1);
  });
});

describe("重试与失败", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const workflow: Workflow = {
    entry: "entry",
    nodes: [
      { id: "entry", type: "process" },
      { id: "S", type: "process" },
      { id: "T", type: "process" },
    ],
    edges: [
      { from: "entry", to: "S" },
      { from: "entry", to: "T" },
    ],
  };

  it("按2/8/32秒重试，第四次失败使运行失败，迟到结果不能复活节点", async () => {
    let sAttempts = 0;
    let resolveT!: (r: HandlerResult) => void;
    const tPromise = new Promise<HandlerResult>((resolve) => {
      resolveT = resolve;
    });
    const engine = new WorkflowEngine({
      process: {
        entry: async () => ({ output: { doc: 1 } }),
        S: async () => {
          sAttempts += 1;
          throw new Error(`boom ${sAttempts}`);
        },
        T: () => tPromise,
      },
    });

    const runId = engine.startRun(workflow, {});
    await vi.advanceTimersByTimeAsync(0);
    let snapshot = engine.getSnapshot(runId);
    expect(nodeStatuses(snapshot).S).toBe("waiting_retry");
    expect(sAttempts).toBe(1);

    // 2 秒内的等待期间出边仍未确定
    await vi.advanceTimersByTimeAsync(1999);
    expect(sAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(7999);
    expect(sAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sAttempts).toBe(3);

    await vi.advanceTimersByTimeAsync(31999);
    expect(sAttempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sAttempts).toBe(4);

    snapshot = engine.getSnapshot(runId);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toContain("S");
    expect(
      snapshot.nodes.find((n) => n.nodeId === "S")!.attempts,
    ).toBe(4);

    // 运行失败后：迟到的处理结果不能重新激活节点
    resolveT({ output: { t: 1 } });
    await vi.advanceTimersByTimeAsync(1000);
    snapshot = engine.getSnapshot(runId);
    expect(snapshot.status).toBe("failed");
    expect(nodeStatuses(snapshot).T).toBe("running");
    expect(snapshot.nodes.find((n) => n.nodeId === "T")!.output).toBeUndefined();

    // 运行失败后复核提交无效
    expect(engine.submitReview(runId, "task_any", {})).toBe(false);
  });
});
