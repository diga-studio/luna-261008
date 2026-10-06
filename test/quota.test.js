import assert from 'node:assert/strict';
import test from 'node:test';
import { splitBranchQuotas } from '../dist/index.js';

test('整除时各分支等于需求乘百分比', () => {
  const quotas = splitBranchQuotas(200, [
    { branchId: 1, percent: 50 },
    { branchId: 2, percent: 50 },
  ]);
  assert.equal(quotas.get(1), 100);
  assert.equal(quotas.get(2), 100);
});

test('余数按小数部分从大到小补给，每个分支最多补一份', () => {
  // 5*34=170 -> 1 余 70；5*33=165 -> 1 余 65（两个）
  const quotas = splitBranchQuotas(5, [
    { branchId: 1, percent: 34 },
    { branchId: 2, percent: 33 },
    { branchId: 3, percent: 33 },
  ]);
  assert.equal(quotas.get(1), 2);
  assert.equal(quotas.get(2), 2);
  assert.equal(quotas.get(3), 1);
});

test('小数部分相同则分支编号小者优先', () => {
  // 1*50=50 -> 0 余 50（两个），剩余 1 份给编号小的分支 1
  const quotas = splitBranchQuotas(1, [
    { branchId: 2, percent: 50 },
    { branchId: 1, percent: 50 },
  ]);
  assert.equal(quotas.get(1), 1);
  assert.equal(quotas.get(2), 0);
});

test('需求为 0 时所有分支额度为 0', () => {
  const quotas = splitBranchQuotas(0, [
    { branchId: 1, percent: 60 },
    { branchId: 2, percent: 40 },
  ]);
  assert.equal(quotas.get(1), 0);
  assert.equal(quotas.get(2), 0);
});

test('大需求下分摊精确且合计等于需求', () => {
  const demand = 1_000_000_000;
  const quotas = splitBranchQuotas(demand, [
    { branchId: 1, percent: 33 },
    { branchId: 2, percent: 33 },
    { branchId: 3, percent: 34 },
  ]);
  assert.equal(quotas.get(1), 330_000_000);
  assert.equal(quotas.get(2), 330_000_000);
  assert.equal(quotas.get(3), 340_000_000);
  assert.equal(quotas.get(1) + quotas.get(2) + quotas.get(3), demand);
});

test('四分支同余数时按编号顺序补足', () => {
  // 7*25=175 -> 各 floor 1 余 75，剩余 3 份依次给编号小的 1、2、3
  const quotas = splitBranchQuotas(7, [
    { branchId: 1, percent: 25 },
    { branchId: 2, percent: 25 },
    { branchId: 3, percent: 25 },
    { branchId: 4, percent: 25 },
  ]);
  assert.equal(quotas.get(1), 2);
  assert.equal(quotas.get(2), 2);
  assert.equal(quotas.get(3), 2);
  assert.equal(quotas.get(4), 1);
});
