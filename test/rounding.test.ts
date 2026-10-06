import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArchive, mat, rev, line } from './helpers.js';
import { runTrial } from '../src/explode.js';

// 两个根件各需 0.4 件同一普通子装配 S，S 每件需 2.5 件原料 M，损耗均为 0。
function sharedSubArchive(subType: 'MANUFACTURED' | 'PHANTOM') {
  return makeArchive({
    materials: [
      mat('A', 'MANUFACTURED'),
      mat('B', 'MANUFACTURED'),
      mat('S', subType),
      mat('M', 'PURCHASED'),
    ],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('RB', 'B', '2026-01-01', '2027-01-01'),
      rev('RS', 'S', '2026-01-01', '2027-01-01'),
    ],
    lines: [
      line('RA', 'S', '0.4', '0'),
      line('RB', 'S', '0.4', '0'),
      line('RS', 'M', '2.5', '0'),
    ],
  });
}

test('共享普通子装配：合并需求后取整，0.4+0.4=0.8 -> 1 件，原料 2.5 -> 3 件', () => {
  const archive = sharedSubArchive('MANUFACTURED');
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [
      { materialId: 'A', revisionId: 'RA', quantity: '1' },
      { materialId: 'B', revisionId: 'RB', quantity: '1' },
    ],
  });
  assert.deepEqual(result.production, [
    { materialId: 'A', revisionId: 'RA', quantity: '1' },
    { materialId: 'B', revisionId: 'RB', quantity: '1' },
    { materialId: 'S', revisionId: 'RS', quantity: '1' },
  ]);
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: '3' }]);
});

test('改为幻影件：不取整不生产，0.8*2.5=2.0 -> 领料 2 件', () => {
  const archive = sharedSubArchive('PHANTOM');
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [
      { materialId: 'A', revisionId: 'RA', quantity: '1' },
      { materialId: 'B', revisionId: 'RB', quantity: '1' },
    ],
  });
  assert.deepEqual(result.production, [
    { materialId: 'A', revisionId: 'RA', quantity: '1' },
    { materialId: 'B', revisionId: 'RB', quantity: '1' },
  ]);
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: '2' }]);
});

test('极小尾数跨越整件边界：1.000001 -> 2，恰好 2.000000 -> 2', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('S', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [rev('RA', 'A', '2026-01-01', '2027-01-01'), rev('RS', 'S', '2026-01-01', '2027-01-01')],
    lines: [line('RA', 'S', '1.000001', '0'), line('RS', 'M', '1', '0')],
  });
  const over = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '1' }],
  });
  assert.deepEqual(over.production.find((p) => p.materialId === 'S')!.quantity, '2');
  assert.deepEqual(over.issue, [{ materialId: 'M', quantity: '2' }]);

  // 两个根件各 0.000001，合并后 0.000002 -> 1 件；若逐个取整会得 2 件
  const archive2 = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('B', 'MANUFACTURED'), mat('S', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('RB', 'B', '2026-01-01', '2027-01-01'),
      rev('RS', 'S', '2026-01-01', '2027-01-01'),
    ],
    lines: [line('RA', 'S', '0.000001', '0'), line('RB', 'S', '0.000001', '0'), line('RS', 'M', '1', '0')],
  });
  const merged = runTrial(archive2, {
    productionDate: '2026-06-01',
    roots: [
      { materialId: 'A', revisionId: 'RA', quantity: '1' },
      { materialId: 'B', revisionId: 'RB', quantity: '1' },
    ],
  });
  assert.deepEqual(merged.production.find((p) => p.materialId === 'S')!.quantity, '1');
  assert.deepEqual(merged.issue, [{ materialId: 'M', quantity: '1' }]);

  // 恰好落在整数上不得多算：0.5 + 0.5 = 1.000000 -> 1
  const archive3 = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('B', 'MANUFACTURED'), mat('S', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('RB', 'B', '2026-01-01', '2027-01-01'),
      rev('RS', 'S', '2026-01-01', '2027-01-01'),
    ],
    lines: [line('RA', 'S', '0.5', '0'), line('RB', 'S', '0.5', '0'), line('RS', 'M', '3', '0')],
  });
  const exact = runTrial(archive3, {
    productionDate: '2026-06-01',
    roots: [
      { materialId: 'A', revisionId: 'RA', quantity: '1' },
      { materialId: 'B', revisionId: 'RB', quantity: '1' },
    ],
  });
  assert.deepEqual(exact.production.find((p) => p.materialId === 'S')!.quantity, '1');
  assert.deepEqual(exact.issue, [{ materialId: 'M', quantity: '3' }]);
});

test('损耗率缺省为 2.5%', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [rev('RA', 'A', '2026-01-01', '2027-01-01')],
    lines: [line('RA', 'M', '1')],
  });
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '40' }],
  });
  // 40 * 1 * 1.025 = 41 恰好整数
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: '41' }]);
});

test('同一组件多条明细全部累加', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [rev('RA', 'A', '2026-01-01', '2027-01-01')],
    lines: [line('RA', 'M', '1', '0'), line('RA', 'M', '2', '0'), line('RA', 'M', '0.5', '0')],
  });
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '2' }],
  });
  // 2 * (1 + 2 + 0.5) = 7
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: '7' }]);
});
