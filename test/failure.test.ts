import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowRunner,
  type Handlers,
  type RunSnapshot,
  type WorkflowDef,
} from "../src/index.js";

/**
 * 拓扑：
 *   extract -> c1(条件) -> flaky / review / slow
 *   flaky -> flakyAfter, review -> reviewAfter, slow -> slowAfter
 * flaky 四次全部失败；review 低置信度挂起；slow 在运行失败后才返回（迟到结果）。
 */
const workflow: WorkflowDef = {
  entry: "extract",
  nodes: [
    { id: "extract", kind: "process" },
    { id: "c1", kind: "condition" },
    { id: "flaky", kind: "process" },
    { id: "flakyAfter", kind: "process" },
    { id: "review", kind: "process" },
    { id: "reviewAfter", kind: "process" },
    { id: "slow", kind: "process" },
    { id: "slowAfter", kind: "process" },
  ],
  edges: [
    { from: "extract", to: "c1" },
    { from: "c1", to: "flaky" },
    { from: "c1", to: "review" },
    { from: "c1", to: "slow" },
    { from: "flaky", to: "flakyAfter" },
    { from: "review", to: "reviewAfter" },
    { from: "slow", to: "slowAfter" },
  ],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("第四次失败使运行失败，迟到结果与复核提交无法重新激活", async () => {
  let flakyCalls = 0;
  const called = new Set<string>();
  const mark = (id: string, output: string) => () => {
    called.add(id);
    return Promise.resolve({ output });
  };

  const handlers: Handlers = {
    process: {
      extract: mark("extract", "fields"),
      flaky: () => {
        flakyCalls += 1;
        return Promise.reject(new Error(`flaky attempt ${flakyCalls} failed`));
      },
      flakyAfter: mark("flakyAfter", "x"),
      review: () => Promise.resolve({ output: { guess: "raw" }, confidence: 10 }),
      reviewAfter: mark("reviewAfter", "x"),
      slow: () => sleep(60).then(() => ({ output: "slow-ok" })),
      slowAfter: mark("slowAfter", "x"),
    },
    condition: {
      c1: () => Promise.resolve({ select: ["flaky", "review", "slow"] }),
    },
  };

  const runner = new WorkflowRunner({ retryDelaysMs: [5, 5, 5] });
  const { runId } = runner.startRun(workflow, handlers, { doc: 1 });
  const snap = () => runner.getRunSnapshot(runId);
  const stateOf = (s: RunSnapshot, id: string) => s.nodes.find((n) => n.id === id)!.state;

  const final = await runner.whenSettled(runId);
  assert.equal(final.status, "failed");
  assert.match(final.error!, /flaky attempt 4 failed/);

  // 最多重试三次，共四次尝试
  assert.equal(flakyCalls, 4);
  assert.equal(final.nodes.find((n) => n.id === "flaky")!.attempts, 4);
  assert.equal(stateOf(final, "flaky"), "failed");

  // 失败后不得启动新步骤：各下游从未执行
  for (const id of ["flakyAfter", "reviewAfter", "slowAfter"]) {
    assert.equal(called.has(id), false, `${id} must not run`);
    assert.equal(stateOf(final, id), "pending");
  }

  // 等 slow 的迟到结果返回后，运行状态与节点集合不再变化
  await sleep(100);
  const after = snap();
  assert.equal(after.status, "failed");
  assert.notEqual(stateOf(after, "slow"), "succeeded");
  assert.equal(called.has("slowAfter"), false);

  // 运行失败后复核提交被拒绝，不能重新激活节点
  const task = after.reviewTasks.find((t) => t.nodeId === "review")!;
  assert.equal(task.status, "pending");
  const submit = runner.submitReview(runId, task.id, { guess: "fixed" });
  assert.equal(submit.accepted, false);
  await sleep(20);
  assert.equal(snap().status, "failed");
  assert.equal(called.has("reviewAfter"), false);
});
