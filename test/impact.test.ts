import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceGraph, analyzeImpact } from '../src/index.js';
import type { Artifact, ArtifactId, TraceLink } from '../src/index.js';

function artifacts(...specs: Array<[ArtifactId, Artifact['type']]>): Artifact[] {
  return specs.map(([id, type]) => ({ id, type }));
}

function sorted(values: Iterable<ArtifactId>): ArtifactId[] {
  return [...values].sort();
}

/**
 * 测试图：
 *   R1 --+            R3 --> T2
 *        v
 *       D1 --> C1 --> C2
 *        ^      ^      |
 *        |      |      v
 *       R2      C3 <--+
 *                |
 *                v
 *               T1
 * R1、R2 在 D1 汇合后进入循环区域 {C1, C2, C3}，T1 为环的下游。
 * R3 是未选定的中间需求。
 */
function buildGraph(): TraceGraph {
  const graph = new TraceGraph();
  graph.load(
    artifacts(
      ['R1', 'requirement'],
      ['R2', 'requirement'],
      ['R3', 'requirement'],
      ['D1', 'design'],
      ['C1', 'change-request'],
      ['C2', 'change-request'],
      ['C3', 'change-request'],
      ['T1', 'test'],
      ['T2', 'test'],
    ),
    [
      { from: 'R1', to: 'D1' },
      { from: 'R2', to: 'D1' },
      { from: 'D1', to: 'C1' },
      { from: 'C1', to: 'C2' },
      { from: 'C2', to: 'C3' },
      { from: 'C3', to: 'C1' },
      { from: 'C3', to: 'T1' },
      { from: 'R3', to: 'T2' },
    ],
  );
  return graph;
}

test('两个来源汇合后进入循环区域：环内及下游均包含两个来源', () => {
  const result = analyzeImpact(buildGraph(), ['R1', 'R2']);

  assert.deepEqual(sorted(result.affectedArtifacts()), ['C1', 'C2', 'C3', 'D1', 'R1', 'R2', 'T1']);
  for (const id of ['D1', 'C1', 'C2', 'C3', 'T1']) {
    assert.deepEqual(sorted(result.sourcesOf(id)), ['R1', 'R2'], `sources of ${id}`);
  }
  // 来源自身受影响且只包含自身（无其他来源可达它）
  assert.deepEqual(sorted(result.sourcesOf('R1')), ['R1']);
  assert.deepEqual(sorted(result.sourcesOf('R2')), ['R2']);
  // 未受影响制品来源为空，且不进入受影响名单
  assert.deepEqual(sorted(result.sourcesOf('T2')), []);
  assert.deepEqual(sorted(result.sourcesOf('R3')), []);
});

test('多条路径到达同一制品时同一来源只出现一次', () => {
  const graph = new TraceGraph();
  graph.load(artifacts(['R1', 'requirement'], ['T1', 'test']), [
    { from: 'R1', to: 'T1' },
    { from: 'R1', to: 'T1' }, // 重复链接去重
  ]);
  graph.addLinks([{ from: 'R1', to: 'T1' }]);
  const result = analyzeImpact(graph, ['R1']);
  assert.deepEqual(sorted(result.sourcesOf('T1')), ['R1']);
});

test('未经选定的中间需求不会变成新来源', () => {
  const graph = buildGraph();
  graph.addLinks([{ from: 'R1', to: 'R3' }]); // R1 经由未选定的 R3 到达 T2
  const result = analyzeImpact(graph, ['R1', 'R2']);
  assert.deepEqual(sorted(result.sourcesOf('R3')), ['R1']);
  assert.deepEqual(sorted(result.sourcesOf('T2')), ['R1']);
});

test('移除唯一通路后环内及下游清除该来源，另一来源保持不变', () => {
  const graph = buildGraph();
  const before = analyzeImpact(graph, ['R1', 'R2']);
  assert.deepEqual(sorted(before.sourcesOf('C2')), ['R1', 'R2']);

  // 删除 R1 进入循环区域的唯一通路
  graph.removeLinks([{ from: 'R1', to: 'D1' }]);
  const after = analyzeImpact(graph, ['R1', 'R2']);
  for (const id of ['D1', 'C1', 'C2', 'C3', 'T1']) {
    assert.deepEqual(sorted(after.sourcesOf(id)), ['R2'], `sources of ${id}`);
  }
  assert.deepEqual(sorted(after.sourcesOf('R1')), ['R1']);
  // 旧结果快照不受后续图变更影响
  assert.deepEqual(sorted(before.sourcesOf('C2')), ['R1', 'R2']);
});

test('删除一条通路但仍有替代通路时影响保留', () => {
  const graph = buildGraph();
  graph.addLinks([{ from: 'R1', to: 'C1' }]); // R1 的替代通路
  graph.removeLinks([{ from: 'R1', to: 'D1' }]);
  const result = analyzeImpact(graph, ['R1', 'R2']);
  assert.deepEqual(sorted(result.sourcesOf('C2')), ['R1', 'R2']);
  assert.deepEqual(sorted(result.sourcesOf('T1')), ['R1', 'R2']);
});

test('更换来源批次后不残留旧批次来源', () => {
  const graph = buildGraph();
  analyzeImpact(graph, ['R1', 'R2']); // 旧批次
  const result = analyzeImpact(graph, ['R3']); // 新批次
  assert.deepEqual(sorted(result.affectedArtifacts()), ['R3', 'T2']);
  assert.deepEqual(sorted(result.sourcesOf('T2')), ['R3']);
  assert.deepEqual(sorted(result.sourcesOf('C1')), []);
});

test('循环区域失去所有来源可达通路后不再显示受影响', () => {
  const graph = buildGraph();
  graph.removeLinks([
    { from: 'R1', to: 'D1' },
    { from: 'R2', to: 'D1' },
  ]);
  const result = analyzeImpact(graph, ['R1', 'R2']);
  // 环内互相引用不能凭空产生来源
  assert.deepEqual(sorted(result.affectedArtifacts()), ['R1', 'R2']);
  for (const id of ['D1', 'C1', 'C2', 'C3', 'T1']) {
    assert.deepEqual(sorted(result.sourcesOf(id)), []);
  }
});

test('来源批次中的需求互相可达时来源集合完整合并', () => {
  const graph = new TraceGraph();
  graph.load(artifacts(['R1', 'requirement'], ['R2', 'requirement']), [
    { from: 'R1', to: 'R2' },
  ]);
  const result = analyzeImpact(graph, ['R1', 'R2']);
  assert.deepEqual(sorted(result.sourcesOf('R2')), ['R1', 'R2']);
  assert.deepEqual(sorted(result.sourcesOf('R1')), ['R1']);
});

test('非需求制品或未知制品不能作为变更来源', () => {
  const graph = buildGraph();
  assert.throws(() => analyzeImpact(graph, ['T1']), /must be a requirement/);
  assert.throws(() => analyzeImpact(graph, ['NOPE']), /unknown artifact/);
});

test('链接必须指向已知制品，删除未知链接是无操作', () => {
  const graph = buildGraph();
  assert.throws(
    () => graph.addLinks([{ from: 'R1', to: 'NOPE' }]),
    /unknown artifact/,
  );
  graph.removeLinks([{ from: 'R1', to: 'NOPE' } as TraceLink]);
  graph.removeLinks([{ from: 'R1', to: 'D1' }]);
  graph.removeLinks([{ from: 'R1', to: 'D1' }]); // 重复删除安全
  const result = analyzeImpact(graph, ['R1']);
  assert.deepEqual(sorted(result.affectedArtifacts()), ['R1']);
});
