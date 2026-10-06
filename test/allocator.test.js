import assert from 'node:assert/strict';
import test from 'node:test';
import { solveAllocation, splitBranchQuotas } from '../dist/index.js';

/** 校验分配结果满足全部分支额度与素材共享上限，并返回总收益（BigInt）。 */
function verifyResult(request, result) {
  assert.equal(result.ok, true);
  const perBranch = new Map();
  const perMaterial = new Map();
  let total = 0n;
  const profitOf = new Map();
  for (const combo of request.combinations) {
    profitOf.set(`${combo.materialId}|${combo.groupId}|${combo.branchId}`, combo.profit);
  }
  const allowed = new Set(profitOf.keys());
  for (const alloc of result.allocations) {
    const key = `${alloc.materialId}|${alloc.groupId}|${alloc.branchId}`;
    assert.ok(allowed.has(key), `分配了未允许的组合: ${key}`);
    assert.ok(Number.isSafeInteger(alloc.impressions) && alloc.impressions > 0);
    const bKey = `${alloc.groupId}|${alloc.branchId}`;
    perBranch.set(bKey, (perBranch.get(bKey) ?? 0) + alloc.impressions);
    perMaterial.set(
      alloc.materialId,
      (perMaterial.get(alloc.materialId) ?? 0) + alloc.impressions,
    );
    total += BigInt(alloc.impressions) * BigInt(profitOf.get(key));
  }
  for (const group of request.groups) {
    const quotas = splitBranchQuotas(group.demand, group.branches);
    for (const [branchId, quota] of quotas) {
      const got = perBranch.get(`${group.groupId}|${branchId}`) ?? 0;
      assert.equal(got, quota, `组 ${group.groupId} 分支 ${branchId} 额度未满足`);
    }
  }
  for (const material of request.materials) {
    const used = perMaterial.get(material.materialId) ?? 0;
    assert.ok(used <= material.capacity, `素材 ${material.materialId} 超出共享上限`);
  }
  assert.equal(total, result.totalProfit);
  return total;
}

test('多地域争抢高收益素材：唯一可用素材的地域优先，其余用替代素材', () => {
  const request = {
    materials: [
      { materialId: 'M-hot', capacity: 100 },
      { materialId: 'M-alt', capacity: 1000 },
    ],
    groups: [
      {
        groupId: 'R1|S1',
        regionCode: 'R1',
        segmentId: 'S1',
        demand: 100,
        branches: [
          { branchId: 1, percent: 50 },
          { branchId: 2, percent: 50 },
        ],
      },
      {
        groupId: 'R2|S1',
        regionCode: 'R2',
        segmentId: 'S1',
        demand: 100,
        branches: [
          { branchId: 1, percent: 50 },
          { branchId: 2, percent: 50 },
        ],
      },
    ],
    combinations: [
      // R1 两个分支都只能用 M-hot
      { materialId: 'M-hot', groupId: 'R1|S1', branchId: 1, profit: 10 },
      { materialId: 'M-hot', groupId: 'R1|S1', branchId: 2, profit: 10 },
      // R2 可用 M-hot（高收益）或 M-alt（替代，低收益）
      { materialId: 'M-hot', groupId: 'R2|S1', branchId: 1, profit: 10 },
      { materialId: 'M-hot', groupId: 'R2|S1', branchId: 2, profit: 10 },
      { materialId: 'M-alt', groupId: 'R2|S1', branchId: 1, profit: 5 },
      { materialId: 'M-alt', groupId: 'R2|S1', branchId: 2, profit: 5 },
    ],
  };
  const result = solveAllocation(request);
  const total = verifyResult(request, result);
  // 已知最优：R1 独占 M-hot(100)，R2 全部走 M-alt(100)
  assert.equal(total, 100n * 10n + 100n * 5n);
  for (const alloc of result.allocations) {
    if (alloc.materialId === 'M-hot') assert.equal(alloc.groupId, 'R1|S1');
  }
});

test('必须接受负收益才能完成投放时仍完成全部额度', () => {
  const request = {
    materials: [
      { materialId: 'M-neg', capacity: 50 },
      { materialId: 'M-pos', capacity: 50 },
    ],
    groups: [
      {
        groupId: 'R1|S1',
        regionCode: 'R1',
        segmentId: 'S1',
        demand: 100,
        branches: [
          { branchId: 1, percent: 50 },
          { branchId: 2, percent: 50 },
        ],
      },
    ],
    combinations: [
      { materialId: 'M-neg', groupId: 'R1|S1', branchId: 1, profit: -7 },
      { materialId: 'M-pos', groupId: 'R1|S1', branchId: 2, profit: 3 },
    ],
  };
  const result = solveAllocation(request);
  const total = verifyResult(request, result);
  assert.equal(total, 50n * -7n + 50n * 3n);
});

test('小需求产生余数且余数相同：按分支编号补足后再分配', () => {
  const request = {
    materials: [{ materialId: 'M1', capacity: 100 }],
    groups: [
      {
        groupId: 'R1|S1',
        regionCode: 'R1',
        segmentId: 'S1',
        demand: 1,
        branches: [
          { branchId: 1, percent: 50 },
          { branchId: 2, percent: 50 },
        ],
      },
    ],
    combinations: [
      { materialId: 'M1', groupId: 'R1|S1', branchId: 1, profit: 4 },
      { materialId: 'M1', groupId: 'R1|S1', branchId: 2, profit: 9 },
    ],
  };
  const result = solveAllocation(request);
  const total = verifyResult(request, result);
  // 唯一一份曝光必须给分支 1（余数相同编号小者优先），即使分支 2 收益更高
  assert.equal(total, 4n);
  assert.deepEqual(result.allocations, [
    { materialId: 'M1', groupId: 'R1|S1', branchId: 1, impressions: 1 },
  ]);
});

test('总素材上限充足但可投放范围不足：返回无可行方案', () => {
  const request = {
    materials: [
      { materialId: 'M1', capacity: 1_000_000 },
      { materialId: 'M2', capacity: 1_000_000 },
    ],
    groups: [
      {
        groupId: 'R1|S1',
        regionCode: 'R1',
        segmentId: 'S1',
        demand: 100,
        branches: [
          { branchId: 1, percent: 50 },
          { branchId: 2, percent: 50 },
        ],
      },
    ],
    combinations: [
      // 分支 2 没有任何允许投放的组合
      { materialId: 'M1', groupId: 'R1|S1', branchId: 1, profit: 8 },
    ],
  };
  const result = solveAllocation(request);
  assert.deepEqual(result, { ok: false, reason: 'infeasible' });
});

test('素材共享上限被多地域共同消耗，超额部分转用替代素材', () => {
  const groups = [];
  const combinations = [];
  for (let r = 1; r <= 4; r += 1) {
    const groupId = `R${r}|S1`;
    groups.push({
      groupId,
      regionCode: `R${r}`,
      segmentId: 'S1',
      demand: 60,
      branches: [
        { branchId: 1, percent: 50 },
        { branchId: 2, percent: 50 },
      ],
    });
    for (const branchId of [1, 2]) {
      combinations.push({ materialId: 'M-shared', groupId, branchId, profit: 10 });
      combinations.push({ materialId: 'M-backup', groupId, branchId, profit: 1 });
    }
  }
  const request = {
    materials: [
      { materialId: 'M-shared', capacity: 120 },
      { materialId: 'M-backup', capacity: 1000 },
    ],
    groups,
    combinations,
  };
  const result = solveAllocation(request);
  const total = verifyResult(request, result);
  // 共享素材 120 份全部用满，剩余 120 份走替代素材
  assert.equal(total, 120n * 10n + 120n * 1n);
});

test('需求为 0 的组不分配曝光', () => {
  const request = {
    materials: [{ materialId: 'M1', capacity: 10 }],
    groups: [
      {
        groupId: 'R1|S1',
        regionCode: 'R1',
        segmentId: 'S1',
        demand: 0,
        branches: [
          { branchId: 1, percent: 50 },
          { branchId: 2, percent: 50 },
        ],
      },
    ],
    combinations: [{ materialId: 'M1', groupId: 'R1|S1', branchId: 1, profit: 5 }],
  };
  const result = solveAllocation(request);
  assert.deepEqual(result, { ok: true, allocations: [], totalProfit: 0n });
});

test('非法输入抛出异常', () => {
  const base = {
    materials: [{ materialId: 'M1', capacity: 10 }],
    groups: [
      {
        groupId: 'R1|S1',
        regionCode: 'R1',
        segmentId: 'S1',
        demand: 10,
        branches: [
          { branchId: 1, percent: 50 },
          { branchId: 2, percent: 50 },
        ],
      },
    ],
    combinations: [],
  };
  assert.throws(() => solveAllocation({ ...base, materials: [{ materialId: 'M1', capacity: -1 }] }));
  assert.throws(() =>
    solveAllocation({
      ...base,
      groups: [{ ...base.groups[0], branches: [{ branchId: 1, percent: 100 }] }],
    }),
  );
  assert.throws(() =>
    solveAllocation({
      ...base,
      groups: [
        {
          ...base.groups[0],
          branches: [
            { branchId: 1, percent: 60 },
            { branchId: 2, percent: 50 },
          ],
        },
      ],
    }),
  );
  assert.throws(() =>
    solveAllocation({
      ...base,
      combinations: [{ materialId: 'M-x', groupId: 'R1|S1', branchId: 1, profit: 1 }],
    }),
  );
});
