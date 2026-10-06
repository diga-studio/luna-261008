import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowRunner, type Handlers, type NodeInput, type WorkflowDef } from "../src/index.js";

/**
 * 拓扑：
 *   extract -> c1(条件) -> a / b / dead
 *   a -> c2(条件) -> a1 / a2
 *   a1 -> join, b -> join        （跨分支共享后继）
 *   a2 -> mix,  b -> mix         （a2 被排除，mix 仍被 b 激活）
 *   dead -> deadChild            （全部入边被排除，级联跳过）
 * c1 选择 [a, b]，c2 选择 [a1]
 */
const workflow: WorkflowDef = {
  entry: "extract",
  nodes: [
    { id: "extract", kind: "process" },
    { id: "c1", kind: "condition" },
    { id: "a", kind: "process" },
    { id: "b", kind: "process" },
    { id: "dead", kind: "process" },
    { id: "deadChild", kind: "process" },
    { id: "c2", kind: "condition" },
    { id: "a1", kind: "process" },
    { id: "a2", kind: "process" },
    { id: "join", kind: "process" },
    { id: "mix", kind: "process" },
  ],
  edges: [
    { from: "extract", to: "c1" },
    { from: "c1", to: "a" },
    { from: "c1", to: "b" },
    { from: "c1", to: "dead" },
    { from: "a", to: "c2" },
    { from: "c2", to: "a1" },
    { from: "c2", to: "a2" },
    { from: "a1", to: "join" },
    { from: "b", to: "join" },
    { from: "a2", to: "mix" },
    { from: "b", to: "mix" },
    { from: "dead", to: "deadChild" },
  ],
};

test("嵌套分流、共享后继与全部入边排除", async () => {
  const inputs = new Map<string, NodeInput>();
  const record = (id: string) => (input: NodeInput) => {
    inputs.set(id, input);
    return Promise.resolve({ output: `out-${id}` });
  };
  const handlers: Handlers = {
    process: {
      extract: record("extract"),
      a: record("a"),
      b: record("b"),
      dead: record("dead"),
      deadChild: record("deadChild"),
      a1: record("a1"),
      a2: record("a2"),
      join: record("join"),
      mix: record("mix"),
    },
    condition: {
      c1: (input) => { inputs.set("c1", input); return Promise.resolve({ output: "out-c1", select: ["a", "b"] }); },
      c2: (input) => { inputs.set("c2", input); return Promise.resolve({ output: "out-c2", select: ["a1"] }); },
    },
  };

  const runner = new WorkflowRunner();
  const { runId } = runner.startRun(workflow, handlers, { docField: 1 });
  const snap = await runner.whenSettled(runId);

  assert.equal(snap.status, "succeeded");
  const stateOf = (id: string) => snap.nodes.find((n) => n.id === id)!.state;

  // 最终执行集合
  const executed = snap.nodes.filter((n) => n.state === "succeeded").map((n) => n.id).sort();
  assert.deepEqual(executed, ["a", "a1", "b", "c1", "c2", "extract", "join", "mix"]);

  // 跳过集合：未选中分支及其下游级联跳过
  assert.deepEqual(
    snap.nodes.filter((n) => n.state === "skipped").map((n) => n.id).sort(),
    ["a2", "dead", "deadChild"],
  );
  assert.equal(stateOf("join"), "succeeded");

  // 入口输入为文档字段本身
  assert.deepEqual(inputs.get("extract"), { docField: 1 });
  // 汇合输入包含全部选中前驱的最终输出
  assert.deepEqual(inputs.get("join"), { a1: "out-a1", b: "out-b" });
  // 共享后继不被跳过前驱遗漏：mix 只收到 b 的输出
  assert.deepEqual(inputs.get("mix"), { b: "out-b" });
  // 嵌套条件节点的输入
  assert.deepEqual(inputs.get("c2"), { a: "out-a" });

  // 跳过的节点没有输出
  for (const id of ["a2", "dead", "deadChild"]) {
    assert.equal(snap.nodes.find((n) => n.id === id)!.output, undefined);
  }

  // 边状态：未选中的出边被排除，不会一直 undetermined
  const edgeState = (from: string, to: string) =>
    snap.edges.find((e) => e.from === from && e.to === to)!.state;
  assert.equal(edgeState("c1", "dead"), "excluded");
  assert.equal(edgeState("dead", "deadChild"), "excluded");
  assert.equal(edgeState("c2", "a2"), "excluded");
  assert.equal(edgeState("a2", "mix"), "excluded");
  assert.equal(edgeState("b", "mix"), "selected");
  assert.equal(edgeState("a1", "join"), "selected");
  assert.equal(edgeState("b", "join"), "selected");
  for (const e of snap.edges) {
    assert.notEqual(e.state, "undetermined", `${e.from}->${e.to} must be determined`);
  }

  // 无复核任务
  assert.equal(snap.reviewTasks.length, 0);
});
