import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImpactTraceLibrary } from '../src/index.js';
import type { Artifact, TraceLink } from '../src/index.js';

/** 场景图：两个来源汇合后进入循环区域，环有下游 */
const ARTIFACTS: Artifact[] = [
  { id: 'R1', type: 'requirement' },
  { id: 'R2', type: 'requirement' },
  { id: 'R3', type: 'requirement' },
  { id: 'RM', type: 'requirement' },
  { id: 'X', type: 'design-doc' },
  { id: 'C1', type: 'design-doc' },
  { id: 'C2', type: 'test' },
  { id: 'C3', type: 'design-doc' },
  { id: 'T1', type: 'test' },
  { id: 'CR1', type: 'change-request' },
];

const LINKS: TraceLink[] = [
  { from: 'R1', to: 'X' },   // 来源 1 进入汇合点
  { from: 'R2', to: 'X' },   // 来源 2 进入汇合点
  { from: 'X', to: 'C1' },   // 汇合后进入循环区域
  { from: 'C1', to: 'C2' },
  { from: 'C2', to: 'C3' },
  { from: 'C3', to: 'C1' },  // 环：C1 -> C2 -> C3 -> C1
  { from: 'C3', to: 'T1' },  // 环的下游
  { from: 'T1', to: 'CR1' }, // 跨类型下游
  { from: 'R1', to: 'RM' },  // 未经选定的中间需求
  { from: 'RM', to: 'T1' },
];

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function fixture(): ImpactTraceLibrary {
  const lib = new ImpactTraceLibrary();
  lib.loadGraph(ARTIFACTS, LINKS);
  return lib;
}

test('两个来源汇合后进入循环区域：环内及下游均含两个来源，不漏不重复不多余', () => {
  const lib = fixture();
  lib.analyze(['R1', 'R2']);

  assert.deepEqual(sorted(lib.getAffectedArtifacts()), ['C1', 'C2', 'C3', 'CR1', 'R1', 'R2', 'RM', 'T1', 'X']);
  // 汇合点、环内、下游均包含且仅包含两个来源
  for (const id of ['X', 'C1', 'C2', 'C3', 'T1', 'CR1']) {
    assert.deepEqual(sorted(lib.getSourcesOf(id)), ['R1', 'R2'], `sources of ${id}`);
  }
  // 来源自身受影响且包含自身
  assert.deepEqual(lib.getSourcesOf('R1'), ['R1']);
  assert.deepEqual(lib.getSourcesOf('R2'), ['R2']);
  // 未经选定的中间需求受影响但不变成新来源
  assert.deepEqual(lib.getSourcesOf('RM'), ['R1']);
  // 与任何来源无关的制品不受影响
  assert.deepEqual(lib.getSourcesOf('R3'), []);
});

test('移除唯一通路后清除对应来源，替代通路保持不变', () => {
  const lib = fixture();
  lib.analyze(['R1', 'R2']);
  assert.deepEqual(sorted(lib.getSourcesOf('T1')), ['R1', 'R2']);

  // 删除 R1 进入循环区域的唯一通路
  lib.removeLinks([{ from: 'R1', to: 'X' }]);
  lib.analyze(['R1', 'R2']);

  // 环内清除 R1，R2 经替代通路保留
  for (const id of ['X', 'C1', 'C2', 'C3']) {
    assert.deepEqual(lib.getSourcesOf(id), ['R2'], `sources of ${id}`);
  }
  // R1 经 RM 仍可达 T1，T1 及其下游 CR1 保留两个来源
  assert.deepEqual(sorted(lib.getSourcesOf('T1')), ['R1', 'R2']);
  assert.deepEqual(sorted(lib.getSourcesOf('CR1')), ['R1', 'R2']);
  // R1 自身仍受影响
  assert.deepEqual(lib.getSourcesOf('R1'), ['R1']);
});

test('循环区域失去所有来源可达通路后不再显示受影响', () => {
  const lib = fixture();
  lib.removeLinks([{ from: 'R1', to: 'X' }, { from: 'R2', to: 'X' }]);
  lib.analyze(['R1', 'R2']);

  // 循环区域仅靠内部互相引用，不进入受影响名单
  for (const id of ['X', 'C1', 'C2', 'C3']) {
    assert.deepEqual(lib.getSourcesOf(id), [], `sources of ${id}`);
  }
  assert.deepEqual(sorted(lib.getAffectedArtifacts()), ['CR1', 'R1', 'R2', 'RM', 'T1']);
  // T1 及其下游 CR1 仍经 RM 被 R1 触及
  assert.deepEqual(lib.getSourcesOf('T1'), ['R1']);
  assert.deepEqual(lib.getSourcesOf('CR1'), ['R1']);
});

test('更换来源批次后，下一次分析不残留旧批次来源', () => {
  const lib = fixture();
  lib.analyze(['R1', 'R2']);
  assert.deepEqual(sorted(lib.getSourcesOf('C1')), ['R1', 'R2']);

  lib.analyze(['R2']);
  for (const id of ['X', 'C1', 'C2', 'C3', 'T1', 'CR1']) {
    assert.deepEqual(lib.getSourcesOf(id), ['R2'], `sources of ${id}`);
  }
  // R1 不在本批，且 R2 无法到达 R1，故 R1 不再受影响
  assert.deepEqual(lib.getSourcesOf('R1'), []);
  assert.ok(!lib.getAffectedArtifacts().includes('R1'));
  // RM 只被 R1 触及，本批不再受影响
  assert.deepEqual(lib.getSourcesOf('RM'), []);

  // 换成互不相干的批次
  lib.analyze(['R3']);
  assert.deepEqual(sorted(lib.getAffectedArtifacts()), ['R3']);
  assert.deepEqual(lib.getSourcesOf('C1'), []);
});

test('同一来源经多条路径到达同一制品时只出现一次', () => {
  const lib = new ImpactTraceLibrary();
  lib.loadGraph(
    [
      { id: 'S', type: 'requirement' },
      { id: 'A', type: 'test' },
      { id: 'B', type: 'test' },
      { id: 'D', type: 'design-doc' },
    ],
    [
      { from: 'S', to: 'A' },
      { from: 'S', to: 'B' },
      { from: 'A', to: 'D' },
      { from: 'B', to: 'D' },
      { from: 'D', to: 'S' }, // 回指来源的循环
    ],
  );
  lib.analyze(['S']);
  assert.deepEqual(lib.getSourcesOf('D'), ['S']);
  assert.deepEqual(lib.getSourcesOf('S'), ['S']);
});

test('来源校验：未知制品或非需求时报错', () => {
  const lib = fixture();
  assert.throws(() => lib.analyze(['NOPE']), /unknown source artifact/);
  assert.throws(() => lib.analyze(['T1']), /source must be a requirement/);
});

test('分析前查询结果报错；图变更后旧结果失效', () => {
  const lib = fixture();
  assert.throws(() => lib.getAffectedArtifacts(), /call analyze/);
  lib.analyze(['R1']);
  assert.ok(lib.getAffectedArtifacts().length > 0);
  lib.addLinks([{ from: 'R3', to: 'T1' }]);
  assert.throws(() => lib.getAffectedArtifacts(), /call analyze/);
  lib.analyze(['R3']);
  assert.deepEqual(sorted(lib.getAffectedArtifacts()), ['CR1', 'R3', 'T1']);
});
