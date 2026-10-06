import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BomArchive, runTrial, TrialError, type BomArchiveData } from '../src/index.js';

test('有效期边界：失效日不含当日，前后选中不同修订', () => {
  const data: BomArchiveData = {
    materials: [
      { materialId: 'A', type: 'manufactured' },
      { materialId: 'S', type: 'manufactured' },
      { materialId: 'P1', type: 'purchased' },
      { materialId: 'P2', type: 'purchased' },
    ],
    revisions: [
      {
        revisionId: 'A-1',
        materialId: 'A',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'S', quantity: '1', lossRate: '0' }],
      },
      {
        revisionId: 'S-OLD',
        materialId: 'S',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-02-01',
        lines: [{ componentId: 'P1', quantity: '1', lossRate: '0' }],
      },
      {
        revisionId: 'S-NEW',
        materialId: 'S',
        effectiveFrom: '2026-02-01',
        lines: [{ componentId: 'P2', quantity: '1', lossRate: '0' }],
      },
    ],
  };
  const archive = new BomArchive(data);
  // 2026-01-31 仍属 S-OLD（失效日 2026-02-01 不含当日）
  const before = runTrial(archive, {
    productionDate: '2026-01-31',
    roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '2' }],
  });
  assert.deepEqual(before.production, [
    { materialId: 'A', revisionId: 'A-1', quantity: '2' },
    { materialId: 'S', revisionId: 'S-OLD', quantity: '2' },
  ]);
  assert.deepEqual(before.consumption, [{ materialId: 'P1', quantity: '2' }]);
  // 2026-02-01 起选中 S-NEW
  const after = runTrial(archive, {
    productionDate: '2026-02-01',
    roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '2' }],
  });
  assert.deepEqual(after.production, [
    { materialId: 'A', revisionId: 'A-1', quantity: '2' },
    { materialId: 'S', revisionId: 'S-NEW', quantity: '2' },
  ]);
  assert.deepEqual(after.consumption, [{ materialId: 'P2', quantity: '2' }]);
});

test('根件可显式指定过期修订，不受有效期限制', () => {
  const data: BomArchiveData = {
    materials: [
      { materialId: 'A', type: 'manufactured' },
      { materialId: 'P', type: 'purchased' },
    ],
    revisions: [
      {
        revisionId: 'A-OLD',
        materialId: 'A',
        effectiveFrom: '2020-01-01',
        effectiveTo: '2020-12-31',
        lines: [{ componentId: 'P', quantity: '3', lossRate: '0' }],
      },
    ],
  };
  const archive = new BomArchive(data);
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'A-OLD', quantity: '2' }],
  });
  assert.deepEqual(result.consumption, [{ materialId: 'P', quantity: '6' }]);
});

test('无关历史修订中的循环不影响试算', () => {
  const data: BomArchiveData = {
    materials: [
      { materialId: 'A', type: 'manufactured' },
      { materialId: 'X', type: 'manufactured' },
      { materialId: 'P', type: 'purchased' },
    ],
    revisions: [
      {
        revisionId: 'A-1',
        materialId: 'A',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'P', quantity: '1', lossRate: '0' }],
      },
      // X 的历史修订自循环，但 2026 年无任何有效修订引用 X
      {
        revisionId: 'X-LOOP',
        materialId: 'X',
        effectiveFrom: '2020-01-01',
        effectiveTo: '2020-12-31',
        lines: [{ componentId: 'X', quantity: '1', lossRate: '0' }],
      },
    ],
  };
  const archive = new BomArchive(data);
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '5' }],
  });
  assert.deepEqual(result.consumption, [{ materialId: 'P', quantity: '5' }]);
});

test('实际选中的修订形成循环：整次试算失败', () => {
  const data: BomArchiveData = {
    materials: [
      { materialId: 'A', type: 'manufactured' },
      { materialId: 'B', type: 'manufactured' },
    ],
    revisions: [
      {
        revisionId: 'A-1',
        materialId: 'A',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'B', quantity: '1', lossRate: '0' }],
      },
      {
        revisionId: 'B-1',
        materialId: 'B',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'A', quantity: '1', lossRate: '0' }],
      },
    ],
  };
  const archive = new BomArchive(data);
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '1' }],
      }),
    (err: unknown) => err instanceof TrialError && err.code === 'CYCLE',
  );
});

test('幻影件参与的循环同样失败', () => {
  const data: BomArchiveData = {
    materials: [
      { materialId: 'A', type: 'manufactured' },
      { materialId: 'G', type: 'phantom' },
    ],
    revisions: [
      {
        revisionId: 'A-1',
        materialId: 'A',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'G', quantity: '1', lossRate: '0' }],
      },
      {
        revisionId: 'G-1',
        materialId: 'G',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'A', quantity: '1', lossRate: '0' }],
      },
    ],
  };
  const archive = new BomArchive(data);
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '1' }],
      }),
    (err: unknown) => err instanceof TrialError && err.code === 'CYCLE',
  );
});

test('到达第 13 层：整次试算失败', () => {
  // 链 M1 -> M2 -> ... -> M13，M13 在第 13 层
  const materials = [];
  const revisions = [];
  for (let i = 1; i <= 13; i++) {
    materials.push({ materialId: 'M' + i, type: 'manufactured' as const });
  }
  for (let i = 1; i <= 12; i++) {
    revisions.push({
      revisionId: 'R' + i,
      materialId: 'M' + i,
      effectiveFrom: '2026-01-01',
      lines: [{ componentId: 'M' + (i + 1), quantity: '1', lossRate: '0' }],
    });
  }
  revisions.push({ revisionId: 'R13', materialId: 'M13', effectiveFrom: '2026-01-01', lines: [] });
  const archive = new BomArchive({ materials, revisions });
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'M1', revisionId: 'R1', quantity: '1' }],
      }),
    (err: unknown) => err instanceof TrialError && err.code === 'MAX_DEPTH',
  );
});

test('恰好 12 层可以成功', () => {
  const materials = [];
  const revisions = [];
  for (let i = 1; i <= 12; i++) {
    materials.push({ materialId: 'M' + i, type: 'manufactured' as const });
  }
  for (let i = 1; i <= 11; i++) {
    revisions.push({
      revisionId: 'R' + i,
      materialId: 'M' + i,
      effectiveFrom: '2026-01-01',
      lines: [{ componentId: 'M' + (i + 1), quantity: '1', lossRate: '0' }],
    });
  }
  revisions.push({ revisionId: 'R12', materialId: 'M12', effectiveFrom: '2026-01-01', lines: [] });
  const archive = new BomArchive({ materials, revisions });
  const result = runTrial(archive, {
    productionDate: '2026-06-01',
    roots: [{ materialId: 'M1', revisionId: 'R1', quantity: '1' }],
  });
  assert.equal(result.production.length, 12);
});

test('共享物料同时经短路径和超深路径到达：整次失败', () => {
  // 根件 ROOT 直接 2 层到达 S，同时经 12 层链到达 S（S 位于第 13 层）
  const materials = [
    { materialId: 'ROOT', type: 'manufactured' as const },
    { materialId: 'S', type: 'manufactured' as const },
    { materialId: 'P', type: 'purchased' as const },
  ];
  const revisions = [
    {
      revisionId: 'ROOT-1',
      materialId: 'ROOT',
      effectiveFrom: '2026-01-01',
      lines: [
        { componentId: 'S', quantity: '1', lossRate: '0' },
        { componentId: 'C1', quantity: '1', lossRate: '0' },
      ],
    },
  ];
  for (let i = 1; i <= 11; i++) {
    materials.push({ materialId: 'C' + i, type: 'manufactured' as const });
    revisions.push({
      revisionId: 'C' + i + '-1',
      materialId: 'C' + i,
      effectiveFrom: '2026-01-01',
      lines: [
        i < 11
          ? { componentId: 'C' + (i + 1), quantity: '1', lossRate: '0' }
          : { componentId: 'S', quantity: '1', lossRate: '0' },
      ],
    });
  }
  revisions.push({
    revisionId: 'S-1',
    materialId: 'S',
    effectiveFrom: '2026-01-01',
    lines: [{ componentId: 'P', quantity: '1', lossRate: '0' }],
  });
  const archive = new BomArchive({ materials, revisions });
  // S 经短路径在第 2 层，经 C1..C11 链在第 13 层 → 失败
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'ROOT', revisionId: 'ROOT-1', quantity: '1' }],
      }),
    (err: unknown) => err instanceof TrialError && err.code === 'MAX_DEPTH',
  );
});

test('需要展开的物料没有有效修订：整次失败', () => {
  const data: BomArchiveData = {
    materials: [
      { materialId: 'A', type: 'manufactured' },
      { materialId: 'B', type: 'manufactured' },
    ],
    revisions: [
      {
        revisionId: 'A-1',
        materialId: 'A',
        effectiveFrom: '2026-01-01',
        lines: [{ componentId: 'B', quantity: '1', lossRate: '0' }],
      },
      {
        revisionId: 'B-1',
        materialId: 'B',
        effectiveFrom: '2020-01-01',
        effectiveTo: '2020-12-31',
        lines: [],
      },
    ],
  };
  const archive = new BomArchive(data);
  assert.throws(
    () =>
      runTrial(archive, {
        productionDate: '2026-06-01',
        roots: [{ materialId: 'A', revisionId: 'A-1', quantity: '1' }],
      }),
    (err: unknown) => err instanceof TrialError && err.code === 'NO_VALID_REVISION',
  );
});
