import assert from "node:assert/strict";
import test from "node:test";
import { allocatePool } from "../src/allocation.js";
import type { AllocationEntry } from "../src/allocation.js";

function allocateMap(fixedCost: bigint, revenues: AllocationEntry[]): Map<bigint, bigint> {
  const allocated = allocatePool(fixedCost, revenues);
  const map = new Map<bigint, bigint>();
  for (let i = 0; i < revenues.length; i++) {
    map.set(revenues[i]!.id, allocated[i]!);
  }
  return map;
}

test("空收入列表且成本为 0 返回空结果", () => {
  const result = allocateMap(0n, []);
  assert.equal(result.size, 0);
});

test("空收入列表且成本非 0 抛错", () => {
  assert.throws(() => allocateMap(100n, []));
});

test("整除时无补分", () => {
  const result = allocateMap(100n, [
    { id: 1n, amount: 50n },
    { id: 2n, amount: 50n },
  ]);
  assert.equal(result.get(1n), 50n);
  assert.equal(result.get(2n), 50n);
});

test("余数较大者优先补 1 分", () => {
  // 池 10，金额 1:1:1 -> 理论份额 10/3 = 3.333...，各补后余 1 分给任一（余数相同按编号小优先）
  const result = allocateMap(10n, [
    { id: 1n, amount: 1n },
    { id: 2n, amount: 1n },
    { id: 3n, amount: 1n },
  ]);
  assert.equal(result.get(1n), 4n); // 余数相同，编号小者优先
  assert.equal(result.get(2n), 3n);
  assert.equal(result.get(3n), 3n);
  assert.equal(result.get(1n)! + result.get(2n)! + result.get(3n)!, 10n);
});

test("余数不同：小数部分大者优先", () => {
  // 池 100，金额 3:5:2 -> 份额 30, 50, 20，整除无补分
  const exact = allocateMap(100n, [
    { id: 1n, amount: 3n },
    { id: 2n, amount: 5n },
    { id: 3n, amount: 2n },
  ]);
  assert.equal(exact.get(1n), 30n);
  assert.equal(exact.get(2n), 50n);
  assert.equal(exact.get(3n), 20n);

  // 池 101：理论份额 30.3, 50.5, 20.2 -> 补 1 分给 id=2（余数 .5 最大）
  const result = allocateMap(101n, [
    { id: 1n, amount: 3n },
    { id: 2n, amount: 5n },
    { id: 3n, amount: 2n },
  ]);
  assert.equal(result.get(1n), 30n);
  assert.equal(result.get(2n), 51n);
  assert.equal(result.get(3n), 20n);
});

test("大额金额：超过 2^53 的中间乘积仍精确", () => {
  // 单笔金额上限 1e12，池 1e12，两笔收入 => 乘积 1e24 远超 2^53
  const result = allocateMap(1_000_000_000_000n, [
    { id: 1n, amount: 1_000_000_000_000n },
    { id: 2n, amount: 1_000_000_000_000n },
  ]);
  assert.equal(result.get(1n), 500_000_000_000n);
  assert.equal(result.get(2n), 500_000_000_000n);
});

test("大额金额且余数相同：按编号小者优先，结果与精确理论份额一致", () => {
  // 池 = 999999999999（奇数），两笔等额大额收入
  // 理论份额 = 999999999999/2 = 499999999999.5，余数相同 -> id 小者 +1
  const result = allocateMap(999_999_999_999n, [
    { id: 7n, amount: 1_000_000_000_000n },
    { id: 3n, amount: 1_000_000_000_000n },
  ]);
  assert.equal(result.get(3n), 500_000_000_000n);
  assert.equal(result.get(7n), 499_999_999_999n);
  assert.equal(result.get(3n)! + result.get(7n)!, 999_999_999_999n);
});

test("随机规模下：总和精确等于池金额，且每笔只取 floor 或 floor+1", () => {
  let seed = 42n;
  const rand = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return seed >> 11n;
  };
  const n = 1000;
  const revenues = [];
  let total = 0n;
  for (let i = 0; i < n; i++) {
    const amount = (rand() % 1_000_000_000_000n) + 1n;
    revenues.push({ id: BigInt(i + 1), amount });
    total += amount;
  }
  const fixedCost = rand() % 1_000_000_000_000n;
  const result = allocateMap(fixedCost, revenues);

  let sum = 0n;
  for (const r of revenues) {
    const product = fixedCost * r.amount;
    const floor = product / total;
    const got = result.get(r.id)!;
    assert.ok(got === floor || got === floor + 1n, `id=${r.id} got=${got} floor=${floor}`);
    sum += got;
  }
  assert.equal(sum, fixedCost);
});

test("非法输入抛错", () => {
  assert.throws(() => allocatePool(-1n, [{ id: 1n, amount: 1n }]));
  assert.throws(() => allocatePool(1n, [{ id: 1n, amount: 0n }]));
  assert.throws(() => allocatePool(1n, [{ id: 1n, amount: -5n }]));
});
