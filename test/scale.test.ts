import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate";
import type { AllocationRequest, AllocationSuccess, AllowedCombinationInput, AudienceGroupInput } from "../src/types";

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("总收益超过安全整数范围时仍然精确", () => {
  // 6 个偶数组需 6e9：M1 上限 5.5e9 全部给偶数组(1e6)，其余 0.5e9 只能由 M2 承接(999999)；
  // 6 个奇数组由 M2 承接(1e6)；M1->奇(999997) 不应被选中；需求为 3 的小组由 M3 承接。
  const groups: AudienceGroupInput[] = [];
  for (let i = 0; i < 12; i++) {
    groups.push({
      regionCode: `R${i}`,
      segmentId: "S1",
      demand: 1_000_000_000,
      branches: [
        { branchId: 1, percent: 50 },
        { branchId: 2, percent: 50 },
      ],
    });
  }
  groups.push({
    regionCode: "R12",
    segmentId: "S1",
    demand: 3,
    branches: [
      { branchId: 1, percent: 50 },
      { branchId: 2, percent: 50 },
    ],
  });
  const allowed: AllowedCombinationInput[] = [];
  for (let i = 0; i < 12; i++) {
    const even = i % 2 === 0;
    for (const branchId of [1, 2]) {
      allowed.push({
        materialId: "M1",
        regionCode: `R${i}`,
        segmentId: "S1",
        branchId,
        profitPerImpression: even ? 1_000_000 : 999_997,
      });
      allowed.push({
        materialId: "M2",
        regionCode: `R${i}`,
        segmentId: "S1",
        branchId,
        profitPerImpression: even ? 999_999 : 1_000_000,
      });
    }
  }
  for (const branchId of [1, 2]) {
    allowed.push({
      materialId: "M3",
      regionCode: "R12",
      segmentId: "S1",
      branchId,
      profitPerImpression: 999_999,
    });
  }
  const req: AllocationRequest = {
    materials: [
      { materialId: "M1", capacity: 5_500_000_000 },
      { materialId: "M2", capacity: 6_500_000_000 },
      { materialId: "M3", capacity: 3 },
    ],
    groups,
    allowed,
  };
  const r = allocate(req);
  assert.equal(r.feasible, true);
  if (!r.feasible) return;
  // 最优：M1 给偶数组 5.5e9@1e6，M2 给偶数组 0.5e9@999999 + 奇数组 6e9@1e6，M3 给小组 3@999999。
  const expected =
    5_500_000_000n * 1_000_000n +
    500_000_000n * 999_999n +
    6_000_000_000n * 1_000_000n +
    3n * 999_999n;
  assert.equal(r.totalProfit, expected);
  // 该值超出安全整数范围，用 number 表示必然失真
  assert.ok(r.totalProfit > BigInt(Number.MAX_SAFE_INTEGER));
  assert.notEqual(BigInt(Number(r.totalProfit)), r.totalProfit);
});

test("规定规模：500 素材 / 200 组 / 200 地域 / 20000 组合 / 总需求 1000 亿", () => {
  const rand = mulberry32(20261008);
  const MATERIALS = 500;
  const GROUPS = 200;
  const BRANCH_PERCENTS = [30, 25, 20, 15, 10];
  const DEMAND_PER_GROUP = 500_000_000; // 总需求 1000 亿

  const materials = [];
  for (let i = 0; i < MATERIALS; i++) {
    // 前 200 份为各组专属保底素材，后 300 份为共享素材
    const capacity = i < GROUPS
      ? DEMAND_PER_GROUP
      : Math.floor(rand() * 200_000_000);
    materials.push({ materialId: `M${i}`, capacity });
  }

  const groups: AudienceGroupInput[] = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push({
      regionCode: `R${String(i).padStart(3, "0")}`, // 200 个地域
      segmentId: "S1",
      demand: DEMAND_PER_GROUP,
      branches: BRANCH_PERCENTS.map((percent, b) => ({ branchId: b + 1, percent })),
    });
  }

  const allowed: AllowedCombinationInput[] = [];
  const seen = new Set<string>();
  const profitOf = new Map<string, number>();
  const pushCombo = (materialId: string, groupIdx: number, branchId: number) => {
    const key = `${materialId}|${groupIdx}|${branchId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const profit = Math.floor(rand() * 2_000_001) - 1_000_000;
    allowed.push({
      materialId,
      regionCode: groups[groupIdx]!.regionCode,
      segmentId: "S1",
      branchId,
      profitPerImpression: profit,
    });
    profitOf.set(`${materialId}|${groups[groupIdx]!.regionCode}|S1|${branchId}`, profit);
  };
  // 每组 5 个专属组合（保证可行）
  for (let g = 0; g < GROUPS; g++) {
    for (let b = 1; b <= 5; b++) pushCombo(`M${g}`, g, b);
  }
  // 随机组合补足到 20000
  while (allowed.length < 20_000) {
    const m = Math.floor(rand() * MATERIALS);
    const g = Math.floor(rand() * GROUPS);
    const b = 1 + Math.floor(rand() * 5);
    pushCombo(`M${m}`, g, b);
  }
  assert.equal(allowed.length, 20_000);

  const req: AllocationRequest = { materials, groups, allowed };

  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const r = allocate(req);
  const elapsed = performance.now() - start;
  const memAfter = process.memoryUsage().heapUsed;

  assert.equal(r.feasible, true);
  if (!r.feasible) return;
  const ok: AllocationSuccess = r;

  // 约束 1：每个分支恰好获得其整数额度
  const served = new Map<string, number>();
  for (const a of ok.allocations) {
    const key = `${a.regionCode}|${a.segmentId}|${a.branchId}`;
    served.set(key, (served.get(key) ?? 0) + a.impressions);
  }
  for (const q of ok.branchQuotas) {
    const key = `${q.regionCode}|${q.segmentId}|${q.branchId}`;
    assert.equal(served.get(key) ?? 0, q.quota, `branch quota mismatch: ${key}`);
  }

  // 约束 2：每份素材总分配量不超过上限
  const usedByMaterial = new Map<string, number>();
  for (const a of ok.allocations) {
    usedByMaterial.set(a.materialId, (usedByMaterial.get(a.materialId) ?? 0) + a.impressions);
  }
  for (const m of materials) {
    assert.ok((usedByMaterial.get(m.materialId) ?? 0) <= m.capacity, `capacity exceeded: ${m.materialId}`);
  }

  // 约束 3：总收益与逐组合重算结果精确一致（bigint）
  let recomputed = 0n;
  for (const a of ok.allocations) {
    const profit = profitOf.get(`${a.materialId}|${a.regionCode}|${a.segmentId}|${a.branchId}`)!;
    recomputed += BigInt(a.impressions) * BigInt(profit);
  }
  assert.equal(ok.totalProfit, recomputed);

  // 非功能：30 秒与 512 MiB 限制
  assert.ok(elapsed < 30_000, `too slow: ${elapsed.toFixed(0)}ms`);
  assert.ok(
    memAfter - memBefore < 512 * 1024 * 1024,
    `too much memory: ${((memAfter - memBefore) / 1024 / 1024).toFixed(1)} MiB`,
  );
  console.log(
    `scale test: ${elapsed.toFixed(0)}ms, heap delta ${((memAfter - memBefore) / 1024 / 1024).toFixed(1)} MiB, totalProfit=${ok.totalProfit}`,
  );
});
