import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBranchQuotas } from "../src/quota";
import type { AudienceGroupInput } from "../src/types";

function group(demand: number, branches: [number, number][]): AudienceGroupInput {
  return {
    regionCode: "R1",
    segmentId: "S1",
    demand,
    branches: branches.map(([branchId, percent]) => ({ branchId, percent })),
  };
}

test("整除时各分支恰好按比例分配", () => {
  const quotas = computeBranchQuotas(group(1000, [[1, 50], [2, 30], [3, 20]]));
  assert.deepEqual(quotas.map((q) => q.quota), [500, 300, 200]);
});

test("余数按小数部分从大到小补齐", () => {
  // 需求 10，比例 33/33/34 -> 各 3.3/3.3/3.4，floor 3/3/3，余 1 补给余数最大的分支 3
  const quotas = computeBranchQuotas(group(10, [[1, 33], [2, 33], [3, 34]]));
  assert.deepEqual(quotas.map((q) => q.quota), [3, 3, 4]);
});

test("余数相同则分支编号小的优先", () => {
  // 需求 5，比例 50/50 -> 各 2.5，余 1 补给编号小的分支 1
  const quotas = computeBranchQuotas(group(5, [[1, 50], [2, 50]]));
  assert.deepEqual(quotas.map((q) => q.quota), [3, 2]);
});

test("多个分支余数相同按编号顺序依次补齐", () => {
  // 需求 7，比例 34/33/33 -> 2.38/2.31/2.31，floor 2/2/2 余 1，余数最大为分支 1
  const quotas = computeBranchQuotas(group(7, [[1, 34], [2, 33], [3, 33]]));
  assert.deepEqual(quotas.map((q) => q.quota), [3, 2, 2]);
  // 需求 8，比例 30/30/40 -> 2.4/2.4/3.2，floor 2/2/3 余 1，分支 1、2 余数相同，编号小者优先
  const quotas2 = computeBranchQuotas(group(8, [[1, 30], [2, 30], [3, 40]]));
  assert.deepEqual(quotas2.map((q) => q.quota), [3, 2, 3]);
});

test("需求为 0 的组所有分支额度为 0", () => {
  const quotas = computeBranchQuotas(group(0, [[1, 50], [2, 50]]));
  assert.deepEqual(quotas.map((q) => q.quota), [0, 0]);
});

test("额度合计恰好等于需求（大需求量的整数精确性）", () => {
  const demand = 1_000_000_000;
  const quotas = computeBranchQuotas(group(demand, [[1, 33], [2, 33], [3, 17], [4, 17]]));
  const sum = quotas.reduce((a, q) => a + q.quota, 0);
  assert.equal(sum, demand);
  // 33% -> 330000000 整除；17% -> 170000000 整除
  assert.deepEqual(quotas.map((q) => q.quota), [330000000, 330000000, 170000000, 170000000]);
});

test("大需求产生余数时仍精确分摊", () => {
  // 999_999_999 * 33 = 32_999_999_967，在安全整数范围内
  const demand = 999_999_999;
  const quotas = computeBranchQuotas(group(demand, [[1, 33], [2, 33], [3, 34]]));
  const sum = quotas.reduce((a, q) => a + q.quota, 0);
  assert.equal(sum, demand);
  // 各分支: 329999999.67 / 329999999.67 / 339999999.66 -> floor 后余 2，补给分支 1、2（余数 .67 相同，编号小者优先）
  assert.deepEqual(quotas.map((q) => q.quota), [330000000, 330000000, 339999999]);
});

test("返回结果保留地域码与人群标识", () => {
  const quotas = computeBranchQuotas({
    regionCode: "CN-EAST",
    segmentId: "young",
    demand: 3,
    branches: [{ branchId: 7, percent: 50 }, { branchId: 2, percent: 50 }],
  });
  assert.equal(quotas[0]!.regionCode, "CN-EAST");
  assert.equal(quotas[0]!.segmentId, "young");
  // 1.5/1.5，余 1 补给编号小的分支 2
  assert.deepEqual(quotas.map((q) => [q.branchId, q.quota]), [[7, 1], [2, 2]]);
});
