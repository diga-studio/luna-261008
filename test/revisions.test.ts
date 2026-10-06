import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArchive, mat, rev, line } from './helpers.js';
import { runTrial } from '../src/explode.js';
import { TrialError } from '../src/types.js';

test('有效期边界前后选中不同修订（生效日含当日，失效日不含当日）', () => {
  // S 有两个不重叠修订：R1 [01-01, 02-01) 用 1 件 M1；R2 [02-01, 03-01) 用 1 件 M2
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('S', 'MANUFACTURED'), mat('M1', 'PURCHASED'), mat('M2', 'PURCHASED')],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('R1', 'S', '2026-01-01', '2026-02-01'),
      rev('R2', 'S', '2026-02-01', '2026-03-01'),
    ],
    lines: [line('RA', 'S', '2', '0'), line('R1', 'M1', '1', '0'), line('R2', 'M2', '1', '0')],
  });
  const before = runTrial(archive, {
    productionDate: '2026-01-31',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '3' }],
  });
  assert.deepEqual(before.production.find((p) => p.materialId === 'S')!.revisionId, 'R1');
  assert.deepEqual(before.issue, [{ materialId: 'M1', quantity: '6' }]);

  const onBoundary = runTrial(archive, {
    productionDate: '2026-02-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '3' }],
  });
  assert.deepEqual(onBoundary.production.find((p) => p.materialId === 'S')!.revisionId, 'R2');
  assert.deepEqual(onBoundary.issue, [{ materialId: 'M2', quantity: '6' }]);

  // 同一档案连续试算互不干扰
  const again = runTrial(archive, {
    productionDate: '2026-01-15',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '1' }],
  });
  assert.deepEqual(again.issue, [{ materialId: 'M1', quantity: '2' }]);
});

test('根件显式指定的修订不受有效期限制', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [rev('ROLD', 'A', '2020-01-01', '2020-12-31')],
    lines: [line('ROLD', 'M', '5', '0')],
  });
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'ROLD', quantity: '2' }],
  });
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: '10' }]);
});

test('实际选中的修订构成循环则整次试算失败', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('X', 'MANUFACTURED'), mat('Y', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('RX', 'X', '2026-01-01', '2027-01-01'),
      rev('RY', 'Y', '2026-01-01', '2027-01-01'),
    ],
    lines: [line('RA', 'X', '1', '0'), line('RX', 'Y', '1', '0'), line('RY', 'X', '1', '0'), line('RX', 'M', '1', '0')],
  });
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'RA', quantity: '1' }],
      }),
    (e: unknown) => e instanceof TrialError && e.code === 'CYCLE_DETECTED',
  );
});

test('需要展开的物料没有有效修订则失败', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('S', 'MANUFACTURED')],
    revisions: [rev('RA', 'A', '2026-01-01', '2027-01-01'), rev('RS', 'S', '2026-01-01', '2026-02-01')],
    lines: [line('RA', 'S', '1', '0')],
  });
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'RA', quantity: '1' }],
      }),
    (e: unknown) => e instanceof TrialError && e.code === 'NO_EFFECTIVE_REVISION',
  );
});

test('到达第 13 层失败；12 层恰好通过', () => {
  // 链：R -> N2 -> ... -> N12 -> M（根第 1 层，M 第 13 层 -> 失败）
  const materials = [mat('R', 'MANUFACTURED'), mat('M', 'PURCHASED')];
  const revisions = [rev('RR', 'R', '2026-01-01', '2027-01-01')];
  const lines = [line('RR', 'N2', '1', '0')];
  for (let i = 2; i <= 12; i++) {
    materials.push(mat(`N${i}`, 'MANUFACTURED'));
    revisions.push(rev(`RN${i}`, `N${i}`, '2026-01-01', '2027-01-01'));
    lines.push(line(`RN${i}`, i === 12 ? 'M' : `N${i + 1}`, '1', '0'));
  }
  const archive = makeArchive({ materials, revisions, lines });
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'R', revisionId: 'RR', quantity: '1' }],
      }),
    (e: unknown) => e instanceof TrialError && e.code === 'DEPTH_EXCEEDED',
  );

  // 去掉一层：R -> N2 -> ... -> N11 -> M（M 第 12 层 -> 通过）
  const lines12 = lines.filter((l) => l.revisionId !== 'RN12');
  const archive12 = makeArchive({
    materials: materials.filter((m) => m.id !== 'N12'),
    revisions: revisions.filter((r) => r.id !== 'RN12'),
    lines: lines12.map((l) => (l.revisionId === 'RN11' ? line('RN11', 'M', '1', '0') : l)),
  });
  const ok = runTrial(archive12, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'R', revisionId: 'RR', quantity: '1' }],
  });
  assert.deepEqual(ok.issue, [{ materialId: 'M', quantity: '1' }]);
});

test('共享物料同时经短路径和超深路径到达：整次失败', () => {
  // X 被根直接引用（第 2 层），也被深链 D1->...->D11->X 引用（X 第 13 层）
  const materials = [mat('R', 'MANUFACTURED'), mat('X', 'MANUFACTURED'), mat('M', 'PURCHASED')];
  const revisions = [
    rev('RR', 'R', '2026-01-01', '2027-01-01'),
    rev('RX', 'X', '2026-01-01', '2027-01-01'),
  ];
  const lines = [line('RR', 'X', '1', '0'), line('RR', 'D1', '1', '0'), line('RX', 'M', '1', '0')];
  for (let i = 1; i <= 11; i++) {
    materials.push(mat(`D${i}`, 'MANUFACTURED'));
    revisions.push(rev(`RD${i}`, `D${i}`, '2026-01-01', '2027-01-01'));
    lines.push(line(`RD${i}`, i === 11 ? 'X' : `D${i + 1}`, '1', '0'));
  }
  const archive = makeArchive({ materials, revisions, lines });
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'R', revisionId: 'RR', quantity: '1' }],
      }),
    (e: unknown) => e instanceof TrialError && e.code === 'DEPTH_EXCEEDED',
  );
});

test('历史循环修订不被选中时试算正常', () => {
  // Y 的有效修订 RY 引用 X 的旧修订不构成有效循环：循环只存在于 X 的过期修订中
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('X', 'MANUFACTURED'), mat('Y', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('RXOLD', 'X', '2020-01-01', '2020-12-31'),
      rev('RXNEW', 'X', '2026-01-01', '2027-01-01'),
      rev('RY', 'Y', '2020-01-01', '2027-01-01'),
    ],
    lines: [
      line('RA', 'X', '2', '0'),
      line('RXOLD', 'Y', '1', '0'), // 过期：X -> Y
      line('RY', 'X', '1', '0'), // Y -> X（若选中 RXOLD 则成环）
      line('RXNEW', 'M', '3', '0'),
    ],
  });
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'RA', quantity: '2' }],
  });
  // X 需求 4 件，经 RXNEW 展开领 M 12 件；Y 与 RXOLD 不参与
  assert.deepEqual(result.production, [
    { materialId: 'A', revisionId: 'RA', quantity: '2' },
    { materialId: 'X', revisionId: 'RXNEW', quantity: '4' },
  ]);
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: '12' }]);
});
