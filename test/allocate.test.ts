import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate";
import type { AllocationRequest, AllocationSuccess } from "../src/types";

function success(req: AllocationRequest): AllocationSuccess {
  const r = allocate(req);
  if (!r.feasible) assert.fail(`expected feasible, got shortages: ${JSON.stringify(r.shortages)}`);
  return r as AllocationSuccess;
}

function sumFor(r: AllocationSuccess, regionCode: string, branchId: number): number {
  return r.allocations
    .filter((a) => a.regionCode === regionCode && a.branchId === branchId)
    .reduce((s, a) => s + a.impressions, 0);
}

test("多地域争抢高收益素材：挤占者让位给唯一可用素材的地域", () => {
  // M1 上限 15；G1(R1) 可用 M1(收益100)/M2(收益1)，G2(R2) 只能用 M1(收益99)
  // 若 G1 抢光 M1，G2 无处可去 -> 必须让 G2 先拿 M1
  const req: AllocationRequest = {
    materials: [
      { materialId: "M1", capacity: 15 },
      { materialId: "M2", capacity: 10 },
    ],
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 10, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
      { regionCode: "R2", segmentId: "S1", demand: 10, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 100 },
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 2, profitPerImpression: 100 },
      { materialId: "M1", regionCode: "R2", segmentId: "S1", branchId: 1, profitPerImpression: 99 },
      { materialId: "M1", regionCode: "R2", segmentId: "S1", branchId: 2, profitPerImpression: 99 },
      { materialId: "M2", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 1 },
      { materialId: "M2", regionCode: "R1", segmentId: "S1", branchId: 2, profitPerImpression: 1 },
    ],
  };
  const r = success(req);
  // 最优：G2 拿 M1 10 次（990），G1 拿 M1 5 次（500）+ M2 5 次（5）= 1495
  assert.equal(r.totalProfit, 1495n);
  // 每个分支恰好 5
  for (const region of ["R1", "R2"]) {
    for (const b of [1, 2]) assert.equal(sumFor(r, region, b), 5);
  }
  // M1 总分配不超过上限 15
  const m1 = r.allocations.filter((a) => a.materialId === "M1").reduce((s, a) => s + a.impressions, 0);
  assert.equal(m1, 15);
});

test("必须接受负收益才能完成投放时，不得少分配", () => {
  const req: AllocationRequest = {
    materials: [{ materialId: "M3", capacity: 4 }],
    groups: [
      { regionCode: "R3", segmentId: "S1", demand: 4, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      { materialId: "M3", regionCode: "R3", segmentId: "S1", branchId: 1, profitPerImpression: -5 },
      { materialId: "M3", regionCode: "R3", segmentId: "S1", branchId: 2, profitPerImpression: -5 },
    ],
  };
  const r = success(req);
  assert.equal(r.totalProfit, -20n);
  assert.equal(sumFor(r, "R3", 1), 2);
  assert.equal(sumFor(r, "R3", 2), 2);
});

test("争抢 + 负收益混合场景，总收益与已知最优一致", () => {
  // 综合：G1(R1) 需 10（M1=100 或 M2=1），G2(R2) 需 10（仅 M1=99），
  // G3(R3) 需 4（仅 M3=-5）。M1 上限 15，M2 上限 10，M3 上限 4。
  const req: AllocationRequest = {
    materials: [
      { materialId: "M1", capacity: 15 },
      { materialId: "M2", capacity: 10 },
      { materialId: "M3", capacity: 4 },
    ],
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 10, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
      { regionCode: "R2", segmentId: "S1", demand: 10, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
      { regionCode: "R3", segmentId: "S1", demand: 4, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 100 },
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 2, profitPerImpression: 100 },
      { materialId: "M1", regionCode: "R2", segmentId: "S1", branchId: 1, profitPerImpression: 99 },
      { materialId: "M1", regionCode: "R2", segmentId: "S1", branchId: 2, profitPerImpression: 99 },
      { materialId: "M2", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 1 },
      { materialId: "M2", regionCode: "R1", segmentId: "S1", branchId: 2, profitPerImpression: 1 },
      { materialId: "M3", regionCode: "R3", segmentId: "S1", branchId: 1, profitPerImpression: -5 },
      { materialId: "M3", regionCode: "R3", segmentId: "S1", branchId: 2, profitPerImpression: -5 },
    ],
  };
  const r = success(req);
  // 990 + 500 + 5 - 20 = 1475
  assert.equal(r.totalProfit, 1475n);
  const totalAllocated = r.allocations.reduce((s, a) => s + a.impressions, 0);
  assert.equal(totalAllocated, 24);
});

test("小需求产生余数且余数相同：编号小者优先，分支额度精确", () => {
  const req: AllocationRequest = {
    materials: [{ materialId: "M1", capacity: 100 }],
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 5, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 3 },
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 2, profitPerImpression: 3 },
    ],
  };
  const r = success(req);
  const q1 = r.branchQuotas.find((q) => q.branchId === 1)!;
  const q2 = r.branchQuotas.find((q) => q.branchId === 2)!;
  assert.equal(q1.quota, 3); // 2.5 vs 2.5，编号小者优先补 1
  assert.equal(q2.quota, 2);
  assert.equal(sumFor(r, "R1", 1), 3);
  assert.equal(sumFor(r, "R1", 2), 2);
  assert.equal(r.totalProfit, 15n);
});

test("需求为 0 的组不分配曝光", () => {
  const req: AllocationRequest = {
    materials: [{ materialId: "M1", capacity: 100 }],
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 0, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
      { regionCode: "R2", segmentId: "S1", demand: 6, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 1000 },
      { materialId: "M1", regionCode: "R2", segmentId: "S1", branchId: 1, profitPerImpression: 10 },
      { materialId: "M1", regionCode: "R2", segmentId: "S1", branchId: 2, profitPerImpression: 10 },
    ],
  };
  const r = success(req);
  assert.equal(r.allocations.some((a) => a.regionCode === "R1"), false);
  assert.equal(r.totalProfit, 60n);
  assert.deepEqual(r.branchQuotas.filter((q) => q.regionCode === "R1").map((q) => q.quota), [0, 0]);
});

test("总素材上限充足但可投放范围不足：明确返回无可行方案", () => {
  const req: AllocationRequest = {
    materials: [{ materialId: "M1", capacity: 1000 }],
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 10, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      // 只有分支 1 可投放，分支 2 无任何可用素材
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 5 },
    ],
  };
  const r = allocate(req);
  assert.equal(r.feasible, false);
  if (!r.feasible) {
    assert.equal(r.shortages.length, 1);
    assert.equal(r.shortages[0]!.branchId, 2);
    assert.equal(r.shortages[0]!.quota, 5);
  }
});

test("素材总上限不足：返回无可行方案", () => {
  const req: AllocationRequest = {
    materials: [{ materialId: "M1", capacity: 3 }],
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 10, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 5 },
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 2, profitPerImpression: 5 },
    ],
  };
  const r = allocate(req);
  assert.equal(r.feasible, false);
});

test("非法输入抛出异常", () => {
  const base: AllocationRequest = {
    materials: [{ materialId: "M1", capacity: 10 }],
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 4, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
    allowed: [
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 1 },
      { materialId: "M1", regionCode: "R1", segmentId: "S1", branchId: 2, profitPerImpression: 1 },
    ],
  };
  // 百分比合计不为 100
  assert.throws(() => allocate({
    ...base,
    groups: [{ regionCode: "R1", segmentId: "S1", demand: 4, branches: [{ branchId: 1, percent: 40 }, { branchId: 2, percent: 50 }] }],
  }));
  // 分支数不足 2
  assert.throws(() => allocate({
    ...base,
    groups: [{ regionCode: "R1", segmentId: "S1", demand: 4, branches: [{ branchId: 1, percent: 100 }] }],
  }));
  // 人群组重复
  assert.throws(() => allocate({
    ...base,
    groups: [
      { regionCode: "R1", segmentId: "S1", demand: 4, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
      { regionCode: "R1", segmentId: "S1", demand: 2, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] },
    ],
  }));
  // 允许组合引用不存在的素材
  assert.throws(() => allocate({
    ...base,
    allowed: [{ materialId: "NOPE", regionCode: "R1", segmentId: "S1", branchId: 1, profitPerImpression: 1 }],
  }));
  // 负需求
  assert.throws(() => allocate({
    ...base,
    groups: [{ regionCode: "R1", segmentId: "S1", demand: -1, branches: [{ branchId: 1, percent: 50 }, { branchId: 2, percent: 50 }] }],
  }));
});
