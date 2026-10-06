import { test } from "node:test";
import assert from "node:assert/strict";
import { MinCostFlowSolver } from "../src/minCostFlow";

test("简单运输问题：贪心会错，最小费用流选对", () => {
  // 源 -> M1(15), M2(10)；M1->A(费用-100), M1->B(-99), M2->A(-1)；A、B 各需 10
  // 最优：B 只能由 M1 供(10)，A 由 M1 供 5 + M2 供 5，总收益 990+500+5=1495
  const s = new MinCostFlowSolver(6); // 0=src 1=M1 2=M2 3=A 4=B 5=sink
  s.addEdge({ from: 0, to: 1, capacity: 15, cost: 0 });
  s.addEdge({ from: 0, to: 2, capacity: 10, cost: 0 });
  s.addEdge({ from: 1, to: 3, capacity: 15, cost: -100 });
  s.addEdge({ from: 1, to: 4, capacity: 15, cost: -99 });
  s.addEdge({ from: 2, to: 3, capacity: 10, cost: -1 });
  s.addEdge({ from: 3, to: 5, capacity: 10, cost: 0 });
  s.addEdge({ from: 4, to: 5, capacity: 10, cost: 0 });
  const r = s.solve(0, 5, 20);
  assert.equal(r.totalFlow, 20);
  // 边顺序: 0:src->M1 1:src->M2 2:M1->A 3:M1->B 4:M2->A 5:A->sink 6:B->sink
  assert.equal(r.edgeFlows[2], 5); // M1->A
  assert.equal(r.edgeFlows[3], 10); // M1->B
  assert.equal(r.edgeFlows[4], 5); // M2->A
});

test("供应不足时返回实际流量（不可行由调用方判断）", () => {
  const s = new MinCostFlowSolver(4);
  s.addEdge({ from: 0, to: 1, capacity: 5, cost: 0 });
  s.addEdge({ from: 1, to: 2, capacity: 5, cost: 3 });
  s.addEdge({ from: 2, to: 3, capacity: 10, cost: 0 });
  const r = s.solve(0, 3, 10);
  assert.equal(r.totalFlow, 5);
});

test("负费用边也必须按需求足量分配", () => {
  const s = new MinCostFlowSolver(4);
  s.addEdge({ from: 0, to: 1, capacity: 100, cost: 0 });
  s.addEdge({ from: 1, to: 2, capacity: 100, cost: 7 });
  s.addEdge({ from: 2, to: 3, capacity: 40, cost: 0 });
  const r = s.solve(0, 3, 40);
  assert.equal(r.totalFlow, 40);
  assert.equal(r.edgeFlows[1], 40);
});

test("需要改道（残量反向边）才能达到最优", () => {
  // 两个供应两个需求，费用设置使得先占便宜的分配必须被后续改道纠正
  // M1 cap 10, M2 cap 10；D1 需 10, D2 需 10
  // M1->D1 费用 0，M1->D2 费用 0，M2->D1 费用 -100（M2 到 D1 极便宜），M2->D2 不存在
  // 若 M1 先占了 D1，最优解需要把 D1 让给 M2：总费用 -1000
  const s = new MinCostFlowSolver(6);
  s.addEdge({ from: 0, to: 1, capacity: 10, cost: 0 }); // src->M1
  s.addEdge({ from: 0, to: 2, capacity: 10, cost: 0 }); // src->M2
  s.addEdge({ from: 1, to: 3, capacity: 10, cost: 0 }); // M1->D1
  s.addEdge({ from: 1, to: 4, capacity: 10, cost: 0 }); // M1->D2
  s.addEdge({ from: 2, to: 3, capacity: 10, cost: -100 }); // M2->D1
  s.addEdge({ from: 3, to: 5, capacity: 10, cost: 0 }); // D1->sink
  s.addEdge({ from: 4, to: 5, capacity: 10, cost: 0 }); // D2->sink
  const r = s.solve(0, 5, 20);
  assert.equal(r.totalFlow, 20);
  assert.equal(r.edgeFlows[4], 10); // M2->D1 全部用上
  assert.equal(r.edgeFlows[2], 0); // M1->D1 被让出
  assert.equal(r.edgeFlows[3], 10); // M1->D2
});
