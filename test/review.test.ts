import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowRunner,
  type Handlers,
  type NodeInput,
  type RunSnapshot,
  type WorkflowDef,
} from "../src/index.js";

/**
 * 拓扑：
 *   extract -> c1(条件) -> review / retry / pass70
 *   review -> after
 *   retry -> retryAfter
 * review 返回低置信度触发复核；retry 先失败两次再成功；pass70 置信度刚好 70。
 */
const workflow: WorkflowDef = {
  entry: "extract",
  nodes: [
    { id: "extract", kind: "process" },
    { id: "c1", kind: "condition" },
    { id: "review", kind: "process" },
    { id: "after", kind: "process" },
    { id: "retry", kind: "process" },
    { id: "retryAfter", kind: "process" },
    { id: "pass70", kind: "process" },
  ],
  edges: [
    { from: "extract", to: "c1" },
    { from: "c1", to: "review" },
    { from: "c1", to: "retry" },
    { from: "c1", to: "pass70" },
    { from: "review", to: "after" },
    { from: "retry", to: "retryAfter" },
  ],
};

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("低置信度复核与其他分支重试", async () => {
  const afterInputs: NodeInput[] = [];
  let retryCalls = 0;

  const handlers: Handlers = {
    process: {
      extract: () => Promise.resolve({ output: "fields" }),
      review: () => Promise.resolve({ output: { guess: "raw" }, confidence: 50 }),
      after: (input) => {
        afterInputs.push(input);
        return Promise.resolve({ output: "after-done" });
      },
      retry: () => {
        retryCalls += 1;
        if (retryCalls < 3) {
          return Promise.reject(new Error(`attempt ${retryCalls} failed`));
        }
        return Promise.resolve({ output: "retry-ok" });
      },
      retryAfter: () => Promise.resolve({ output: "retry-after-done" }),
      pass70: () => Promise.resolve({ output: "pass-ok", confidence: 70 }),
    },
    condition: {
      c1: () => Promise.resolve({ select: ["review", "retry", "pass70"] }),
    },
  };

  const runner = new WorkflowRunner({ retryDelaysMs: [5, 5, 5] });
  const { runId } = runner.startRun(workflow, handlers, { doc: 1 });
  const snap = () => runner.getRunSnapshot(runId);
  const stateOf = (s: RunSnapshot, id: string) => s.nodes.find((n) => n.id === id)!.state;

  // 复核挂起期间，无关分支（含重试）照常推进直至完成
  await waitFor(() => stateOf(snap(), "retryAfter") === "succeeded");
  const mid = snap();
  assert.equal(mid.status, "running");
  assert.equal(stateOf(mid, "review"), "awaiting_review");
  assert.equal(stateOf(mid, "retry"), "succeeded");
  assert.equal(stateOf(mid, "pass70"), "succeeded");
  assert.equal(stateOf(mid, "after"), "pending"); // 仅复核下游被阻塞

  // 重试次数：2 次失败 + 第 3 次成功
  assert.equal(retryCalls, 3);
  assert.equal(mid.nodes.find((n) => n.id === "retry")!.attempts, 3);

  // 只有 review 产生复核任务；置信度 70 直接通过
  assert.equal(mid.reviewTasks.length, 1);
  const task = mid.reviewTasks[0];
  assert.equal(task.nodeId, "review");
  assert.equal(task.status, "pending");
  assert.equal(task.confidence, 50);
  assert.deepEqual(task.originalOutput, { guess: "raw" });

  // 首个提交生效：修正字段整体替代原结果并发布
  const first = runner.submitReview(runId, task.id, { guess: "fixed" });
  assert.equal(first.accepted, true);
  await waitFor(() => snap().status === "succeeded");

  // 下游只被推进一次，且收到的是修正后的结果
  assert.equal(afterInputs.length, 1);
  assert.deepEqual(afterInputs[0], { review: { guess: "fixed" } });

  // 重复/冲突提交不得覆盖，也不得再次推进后继
  const dup = runner.submitReview(runId, task.id, { guess: "conflict" });
  assert.equal(dup.accepted, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(afterInputs.length, 1);

  const final = snap();
  assert.equal(final.status, "succeeded");
  assert.equal(stateOf(final, "review"), "succeeded");
  assert.deepEqual(final.nodes.find((n) => n.id === "review")!.output, { guess: "fixed" });
  assert.equal(final.reviewTasks[0].status, "resolved");
  assert.deepEqual(final.reviewTasks[0].correction, { guess: "fixed" });
});
