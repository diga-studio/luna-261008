import assert from "node:assert/strict";
import test from "node:test";
import { allocatePool, type PoolRevenue } from "../src/allocation.js";

function rev(id: bigint, amountCents: bigint): PoolRevenue {
  return { id, amountCents };
}

/** 把同序返回的数组转成 id -> 分摊 的 Map 便于断言。 */
function toMap(revenues: readonly PoolRevenue[], allocated: bigint[]): Map<bigint, bigint> {
  const m = new Map<bigint, bigint>();
  for (let i = 0; i < revenues.length; i++) m.set(revenues[i]!.id, allocated[i]!);
  return m;
}

test("空池（无收入）不分摊", () => {
  assert.equal(allocatePool(1000n, []).length, 0);
});

test("池金额为 0 时全部分摊为 0", () => {
  const revenues = [rev(1n, 100n), rev(2n, 300n)];
  const result = toMap(revenues, allocatePool(0n, revenues));
  assert.equal(result.get(1n), 0n);
  assert.equal(result.get(2n), 0n);
});

test("整除时无补分", () => {
  const revenues = [rev(1n, 100n), rev(2n, 300n)];
  const result = toMap(revenues, allocatePool(100n, revenues));
  assert.equal(result.get(1n), 25n);
  assert.equal(result.get(2n), 75n);
});

test("小数部分相同时编号小者优先补 1 分", () => {
  // 池 100，收入 100/100/100：每份 33.333…，余 1 分给编号最小者
  const revenues = [rev(1n, 100n), rev(2n, 100n), rev(3n, 100n)];
  const result = toMap(revenues, allocatePool(100n, revenues));
  assert.equal(result.get(1n), 34n);
  assert.equal(result.get(2n), 33n);
  assert.equal(result.get(3n), 33n);
});

test("小数部分较大的收入优先补分", () => {
  // 池 11，收入 3/4/3，总额 10：份额 3.3/4.4/3.3，小数 .4 最大 → id2 补 1
  const revenues = [rev(1n, 3n), rev(2n, 4n), rev(3n, 3n)];
  const result = toMap(revenues, allocatePool(11n, revenues));
  assert.equal(result.get(1n), 3n);
  assert.equal(result.get(2n), 5n);
  assert.equal(result.get(3n), 3n);
});

test("乱序输入时仍按编号小者优先", () => {
  // 池 7，收入 1/1/1：份额 7/3=2.333… 相同 → id 最小者补分
  const revenues = [rev(3n, 1n), rev(1n, 1n), rev(2n, 1n)];
  const result = toMap(revenues, allocatePool(7n, revenues));
  assert.equal(result.get(1n), 3n);
  assert.equal(result.get(2n), 2n);
  assert.equal(result.get(3n), 2n);
});

test("大额金额：分摊之和精确等于池金额", () => {
  const pool = 1_000_000_000_000n;
  const revenues: PoolRevenue[] = [];
  for (let i = 1n; i <= 1000n; i++) {
    revenues.push(rev(i, 999_999_999_999n - i));
  }
  const allocated = allocatePool(pool, revenues);
  let sum = 0n;
  for (const v of allocated) sum += v;
  assert.equal(sum, pool);
});

test("每笔分摊只能是 floor 或 floor+1，补分集合与精确理论份额一致", () => {
  let seed = 42n;
  const rand = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return seed;
  };
  for (let round = 0; round < 50; round++) {
    const n = 1 + Number(rand() % 50n);
    const pool = rand() % 1_000_000_000_000n;
    const revenues: PoolRevenue[] = [];
    for (let i = 0; i < n; i++) {
      revenues.push(rev(BigInt(i + 1), 1n + (rand() % 1_000_000_000_000n)));
    }
    const total = revenues.reduce((a, r) => a + r.amountCents, 0n);
    const result = toMap(revenues, allocatePool(pool, revenues));

    let sum = 0n;
    for (const r of revenues) {
      const floor = (pool * r.amountCents) / total;
      const got = result.get(r.id)!;
      assert.ok(
        got === floor || got === floor + 1n,
        `收入 ${r.id} 分摊 ${got} 既不是 floor(${floor}) 也不是 floor+1`,
      );
      sum += got;
    }
    assert.equal(sum, pool, "分摊之和必须等于池金额");

    // 补分集合必须恰好是 (小数部分 desc, id asc) 前 need 名
    const order = revenues
      .map((r) => ({ id: r.id, rem: (pool * r.amountCents) % total }))
      .sort((a, b) =>
        a.rem !== b.rem ? (a.rem > b.rem ? -1 : 1) : a.id < b.id ? -1 : 1,
      );
    const need = Number(
      pool - revenues.reduce((a, r) => a + (pool * r.amountCents) / total, 0n),
    );
    const expectedPlusOne = new Set(order.slice(0, need).map((o) => o.id));
    for (const r of revenues) {
      const floor = (pool * r.amountCents) / total;
      const isPlusOne = result.get(r.id)! === floor + 1n;
      assert.equal(isPlusOne, expectedPlusOne.has(r.id));
    }
  }
});
