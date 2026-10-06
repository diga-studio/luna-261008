import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArchive, mat, rev, line } from './helpers.js';
import { runTrial } from '../src/explode.js';
import { BomArchive } from '../src/archive.js';
import { TrialError } from '../src/types.js';

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof TrialError && e.code === code);
}

function simpleArchive() {
  return makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [rev('RA', 'A', '2026-01-01', '2027-01-01')],
    lines: [line('RA', 'M', '1', '0')],
  });
}

test('档案校验：重复物料、重复修订、未知组件、未知修订、重叠有效期、外购件带修订', () => {
  expectCode('INVALID_INPUT', () =>
    makeArchive({ materials: [mat('A', 'MANUFACTURED'), mat('A', 'PURCHASED')], revisions: [], lines: [] }),
  );
  expectCode('INVALID_INPUT', () =>
    makeArchive({
      materials: [mat('A', 'MANUFACTURED')],
      revisions: [rev('R1', 'A', '2026-01-01', '2026-06-01'), rev('R1', 'A', '2026-06-01', '2027-01-01')],
      lines: [],
    }),
  );
  expectCode('UNKNOWN_MATERIAL', () =>
    makeArchive({ materials: [mat('A', 'MANUFACTURED')], revisions: [rev('R1', 'A', '2026-01-01', '2027-01-01')], lines: [line('R1', 'XX', '1')] }),
  );
  expectCode('INVALID_INPUT', () =>
    makeArchive({ materials: [mat('A', 'MANUFACTURED'), mat('M', 'PURCHASED')], revisions: [rev('R1', 'A', '2026-01-01', '2027-01-01')], lines: [line('RXX', 'M', '1')] }),
  );
  expectCode('INVALID_INPUT', () =>
    makeArchive({
      materials: [mat('A', 'MANUFACTURED')],
      revisions: [rev('R1', 'A', '2026-01-01', '2026-08-01'), rev('R2', 'A', '2026-06-01', '2027-01-01')],
      lines: [],
    }),
  );
  expectCode('INVALID_INPUT', () =>
    makeArchive({ materials: [mat('M', 'PURCHASED')], revisions: [rev('R1', 'M', '2026-01-01', '2027-01-01')], lines: [] }),
  );
  // 有效期空区间
  expectCode('INVALID_INPUT', () =>
    makeArchive({ materials: [mat('A', 'MANUFACTURED')], revisions: [rev('R1', 'A', '2026-06-01', '2026-06-01')], lines: [] }),
  );
});

test('明细校验：用量与损耗率的格式、精度、范围', () => {
  const base = { materials: [mat('A', 'MANUFACTURED'), mat('M', 'PURCHASED')], revisions: [rev('R1', 'A', '2026-01-01', '2027-01-01')] };
  expectCode('INVALID_INPUT', () => makeArchive({ ...base, lines: [line('R1', 'M', '0')] }));
  expectCode('INVALID_INPUT', () => makeArchive({ ...base, lines: [line('R1', 'M', '-1')] }));
  expectCode('INVALID_INPUT', () => makeArchive({ ...base, lines: [line('R1', 'M', '1.0000001')] })); // 7 位小数
  expectCode('INVALID_INPUT', () => makeArchive({ ...base, lines: [line('R1', 'M', '1000000.000001')] }));
  expectCode('INVALID_INPUT', () => makeArchive({ ...base, lines: [line('R1', 'M', 'abc')] }));
  expectCode('INVALID_INPUT', () => makeArchive({ ...base, lines: [line('R1', 'M', '1', '100.0001')] }));
  expectCode('INVALID_INPUT', () => makeArchive({ ...base, lines: [line('R1', 'M', '1', '0.00001')] })); // 5 位小数
  // 边界值可用
  makeArchive({ ...base, lines: [line('R1', 'M', '1000000', '100')] });
  makeArchive({ ...base, lines: [line('R1', 'M', '0.000001', '0.0001')] });
});

test('试算输入校验：未知物料/修订、非自制根件、修订归属、数量范围、日期格式', () => {
  const archive = simpleArchive();
  const run = (roots: unknown, date = '2026-06-01') =>
    runTrial(archive, { productionDate: date, roots: roots as never });

  expectCode('UNKNOWN_MATERIAL', () => run([{ materialId: 'XX', revisionId: 'RA', quantity: '1' }]));
  expectCode('UNKNOWN_REVISION', () => run([{ materialId: 'A', revisionId: 'RX', quantity: '1' }]));
  expectCode('ROOT_NOT_MANUFACTURED', () => run([{ materialId: 'M', revisionId: 'RA', quantity: '1' }]));
  expectCode('INVALID_INPUT', () => run([{ materialId: 'A', revisionId: 'RA', quantity: '0' }]));
  expectCode('INVALID_INPUT', () => run([{ materialId: 'A', revisionId: 'RA', quantity: '1.5' }]));
  expectCode('INVALID_INPUT', () => run([{ materialId: 'A', revisionId: 'RA', quantity: '1000000000001' }]));
  expectCode('INVALID_INPUT', () => run([{ materialId: 'A', revisionId: 'RA', quantity: '-3' }]));
  expectCode('INVALID_INPUT', () => run([{ materialId: 'A', revisionId: 'RA', quantity: '1' }], '2026/06/01'));
  // 上限 1e12 可用
  const ok = run([{ materialId: 'A', revisionId: 'RA', quantity: '1000000000000' }]);
  assert.deepEqual(ok.issue, [{ materialId: 'M', quantity: '1000000000000' }]);
});

test('修订归属其他物料时报错', () => {
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('B', 'MANUFACTURED')],
    revisions: [rev('RA', 'A', '2026-01-01', '2027-01-01'), rev('RB', 'B', '2026-01-01', '2027-01-01')],
    lines: [],
  });
  expectCode('REVISION_MATERIAL_MISMATCH', () =>
    runTrial(archive, {
      productionDate: '2026-06-01',
      roots: [{ materialId: 'A', revisionId: 'RB', quantity: '1' }],
    }),
  );
});

test('相同物料不同修订分开核算', () => {
  // 根件 A 用旧修订 RX1，展开得到的 X 按日期用 RX2
  const archive = makeArchive({
    materials: [mat('A', 'MANUFACTURED'), mat('X', 'MANUFACTURED'), mat('B', 'MANUFACTURED'), mat('M', 'PURCHASED')],
    revisions: [
      rev('RA', 'A', '2026-01-01', '2027-01-01'),
      rev('RB', 'B', '2026-01-01', '2027-01-01'),
      rev('RX1', 'X', '2026-01-01', '2026-06-01'),
      rev('RX2', 'X', '2026-06-01', '2027-01-01'),
    ],
    lines: [
      line('RA', 'X', '1', '0'), // 日期 2026-09-01 -> X 用 RX2
      line('RB', 'M', '1', '0'),
      line('RX1', 'M', '1', '0'),
      line('RX2', 'M', '10', '0'),
    ],
  });
  const result = runTrial(archive, {
    productionDate: '2026-09-01',
    roots: [
      { materialId: 'A', revisionId: 'RA', quantity: '2' },
      { materialId: 'X', revisionId: 'RX1', quantity: '3' }, // 显式指定旧修订
    ],
  });
  // X(RX1) 生产 3 件（领 M 3 件）；X(RX2) 需求 2 件（领 M 20 件）
  assert.deepEqual(result.production, [
    { materialId: 'A', revisionId: 'RA', quantity: '2' },
    { materialId: 'X', revisionId: 'RX1', quantity: '3' },
    { materialId: 'X', revisionId: 'RX2', quantity: '2' },
  ]);
  assert.deepEqual(result.issue, [{ materialId: 'M', quantity: '23' }]);
});

test('BomArchive 上的查询接口', () => {
  const archive = simpleArchive();
  assert.equal(archive.materialType('A'), 'MANUFACTURED');
  assert.equal(archive.materialType('ZZ'), undefined);
  assert.equal(archive.hasRevision('RA'), true);
  assert.equal(archive.hasRevision('ZZ'), false);
  assert.equal(archive.revision('RA')!.materialId, 'A');
  assert.equal(archive.effectiveRevision('A', '2026-06-01')!.id, 'RA');
  assert.equal(archive.effectiveRevision('A', '2027-06-01'), undefined);
  assert.ok(archive instanceof BomArchive);
});
