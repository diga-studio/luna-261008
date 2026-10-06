import assert from 'node:assert/strict';
import test from 'node:test';
import { solveAllocation } from '../dist/index.js';

/** 确定性伪随机数（LCG），保证测试可复现。 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('规定规模：500 素材 × 200 组 × 5 分支 × 20000 组合，总需求 1e11', () => {
  const MATERIALS = 500;
  const GROUPS = 200;
  const BRANCHES = 5;
  const COMBOS = 20_000;
  const GROUP_DEMAND = 500_000_000; // 200 组共 1e11

  const materials = Array.from({ length: MATERIALS }, (_, i) => ({
    materialId: `M${i}`,
    capacity: 200_000_000, // 合计 1e11，恰好等于总需求
  }));
  const groups = Array.from({ length: GROUPS }, (_, i) => ({
    groupId: `R${i % 200}|S${i}`,
    regionCode: `R${i % 200}`,
    segmentId: `S${i}`,
    demand: GROUP_DEMAND,
    branches: Array.from({ length: BRANCHES }, (_, b) => ({
      branchId: b + 1,
      percent: 20,
    })),
  }));

  const rand = lcg(42);
  const combinations = [];
  const pairs = GROUPS * BRANCHES; // 1000 个人群分支
  for (let c = 0; c < COMBOS; c += 1) {
    const pair = c % pairs;
    combinations.push({
      materialId: `M${(c * 37) % MATERIALS}`,
      groupId: `R${Math.floor(pair / BRANCHES) % 200}|S${Math.floor(pair / BRANCHES)}`,
      branchId: (pair % BRANCHES) + 1,
      profit: Math.floor(rand() * 2_000_001) - 1_000_000,
    });
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = solveAllocation({ materials, groups, combinations });
  const elapsedMs = performance.now() - started;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;

  assert.equal(result.ok, true, '总上限恰好等于总需求，应当可行');

  // 校验每个分支额度与每份素材上限
  const perBranch = new Map();
  const perMaterial = new Map();
  for (const alloc of result.allocations) {
    const bKey = `${alloc.groupId}|${alloc.branchId}`;
    perBranch.set(bKey, (perBranch.get(bKey) ?? 0) + alloc.impressions);
    perMaterial.set(
      alloc.materialId,
      (perMaterial.get(alloc.materialId) ?? 0) + alloc.impressions,
    );
  }
  for (const group of groups) {
    for (const branch of group.branches) {
      assert.equal(
        perBranch.get(`${group.groupId}|${branch.branchId}`),
        GROUP_DEMAND / BRANCHES,
      );
    }
  }
  for (const material of materials) {
    assert.ok((perMaterial.get(material.materialId) ?? 0) <= material.capacity);
  }

  assert.ok(elapsedMs < 30_000, `耗时 ${elapsedMs.toFixed(0)}ms 超过 30s 上限`);
  assert.ok(
    heapDelta < 512 * 1024 * 1024,
    `堆内存增量 ${(heapDelta / 1024 / 1024).toFixed(1)}MiB 超过 512MiB 上限`,
  );
  console.log(
    `    规模测试: ${elapsedMs.toFixed(0)}ms, 堆增量 ${(heapDelta / 1024 / 1024).toFixed(1)}MiB`,
  );
});

test('总收益超过安全整数范围时结果精确（BigInt）', () => {
  const GROUPS = 20;
  const DEMAND = 1_000_000_000; // 每组 1e9，共 2e10 次曝光
  const PROFIT = 1_000_000; // 主体收益 2e16，再加 1 次收益为 1 的曝光

  const materials = [
    { materialId: 'M0', capacity: 5_000_000_001 },
    { materialId: 'M1', capacity: 5_000_000_000 },
    { materialId: 'M2', capacity: 5_000_000_000 },
    { materialId: 'M3', capacity: 5_000_000_000 },
  ];
  const groups = Array.from({ length: GROUPS }, (_, i) => ({
    groupId: `R${i}|S${i}`,
    regionCode: `R${i}`,
    segmentId: `S${i}`,
    demand: DEMAND,
    branches: [
      { branchId: 1, percent: 50 },
      { branchId: 2, percent: 50 },
    ],
  }));
  // 追加一个需求为 1 的组：50/50 分摊后分支 1 得 1 份、分支 2 得 0 份
  groups.push({
    groupId: 'R-tail|S-tail',
    regionCode: 'R-tail',
    segmentId: 'S-tail',
    demand: 1,
    branches: [
      { branchId: 1, percent: 50 },
      { branchId: 2, percent: 50 },
    ],
  });
  const combinations = [];
  for (const group of groups) {
    for (const branchId of [1, 2]) {
      for (const material of materials) {
        combinations.push({
          materialId: material.materialId,
          groupId: group.groupId,
          branchId,
          profit: group.groupId === 'R-tail|S-tail' ? 1 : PROFIT,
        });
      }
    }
  }

  const result = solveAllocation({ materials, groups, combinations });
  assert.equal(result.ok, true);
  // 已知最优：2e10 次曝光 × 1e6 + 1 次 × 1 = 20000000000000001
  const expected = 20_000_000_000_000_001n;
  assert.ok(expected > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(result.totalProfit, expected);
  // 该值无法被 number 精确表示，验证 BigInt 的必要性
  assert.notEqual(BigInt(Number(expected)), expected);
});
