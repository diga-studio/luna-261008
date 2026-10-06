import assert from "node:assert/strict";
import test from "node:test";
import { findCycle } from "../src/cycles.js";
import type { SegmentId } from "../src/types.js";

function graph(edges: [SegmentId, SegmentId][]): Map<SegmentId, SegmentId[]> {
  const adj = new Map<SegmentId, SegmentId[]>();
  for (const [s, t] of edges) {
    if (!adj.has(s)) adj.set(s, []);
    adj.get(s)!.push(t);
    if (!adj.has(t)) adj.set(t, []);
  }
  return adj;
}

test("无环图返回 undefined", () => {
  assert.equal(findCycle(graph([["a", "b"], ["b", "c"]])), undefined);
  assert.equal(findCycle(graph([])), undefined);
});

test("自环不构成闭环", () => {
  assert.equal(findCycle(graph([["a", "a"]])), undefined);
  assert.equal(findCycle(graph([["a", "a"], ["a", "b"]])), undefined);
});

test("两个网段的往返构成闭环", () => {
  const cycle = findCycle(graph([["a", "b"], ["b", "a"]]));
  assert.ok(cycle);
  assert.equal(cycle.length, 2);
});

test("三网段闭环，除首尾外不重复", () => {
  const cycle = findCycle(graph([["a", "b"], ["b", "c"], ["c", "a"]]));
  assert.ok(cycle);
  assert.equal(cycle.length, 3);
  const nodes = cycle.map((h) => h.source);
  assert.equal(new Set(nodes).size, nodes.length);
  for (let i = 0; i < cycle.length; i++) {
    assert.equal(cycle[i]!.target, cycle[(i + 1) % cycle.length]!.source);
  }
});

test("支路不影响闭环发现", () => {
  const cycle = findCycle(graph([["x", "a"], ["a", "b"], ["b", "c"], ["c", "a"], ["c", "d"]]));
  assert.ok(cycle);
  const nodes = new Set(cycle.map((h) => h.source));
  assert.deepEqual([...nodes].sort(), ["a", "b", "c"]);
});
