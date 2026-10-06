/**
 * 纯函数：把一个成本池的固定成本按收入金额占比分摊到各笔收入。
 * 使用类型化数组，单池 100000 笔收入时内存占用保持低位。
 */
export interface AllocationEntry {
  id: bigint;
  amount: bigint;
}

/**
 * 分摊规则：
 * - 每笔收入的理论份额 = fixedCost * amount / totalAmount（精确分数）。
 * - 分摊金额只能是对理论份额向下取整，或向下取整 + 1 分。
 * - 需要补 1 分时，理论份额小数部分（余数）较大者优先；余数相同则收入编号较小者优先。
 * - 所有分摊金额之和恰好等于 fixedCost。
 *
 * 全部使用 bigint 运算，保证任意大额金额下结果精确到分。
 *
 * @returns 与 revenues 同序的 BigInt64Array，第 i 项为 revenues[i] 的分摊金额。
 */
export function allocatePool(
  fixedCost: bigint,
  revenues: readonly AllocationEntry[],
): BigInt64Array {
  const ids = new BigInt64Array(revenues.length);
  const amounts = new BigInt64Array(revenues.length);
  for (let i = 0; i < revenues.length; i++) {
    const entry = revenues[i]!;
    if (entry.amount <= 0n) {
      throw new RangeError(`revenue ${entry.id} has non-positive amount`);
    }
    ids[i] = entry.id;
    amounts[i] = entry.amount;
  }
  return allocatePoolArrays(fixedCost, ids, amounts);
}

/**
 * 类型化数组版本的分摊实现，供大数据量路径直接调用。
 * ids 与 amounts 等长且一一对应；返回与输入同序的分摊金额。
 */
export function allocatePoolArrays(
  fixedCost: bigint,
  ids: BigInt64Array,
  amounts: BigInt64Array,
): BigInt64Array {
  if (fixedCost < 0n) {
    throw new RangeError("fixedCost must be non-negative");
  }
  const count = ids.length;
  const allocated = new BigInt64Array(count);
  if (count === 0) {
    if (fixedCost !== 0n) {
      throw new Error("cannot allocate a non-zero pool with no revenues");
    }
    return allocated;
  }

  let totalAmount = 0n;
  for (let i = 0; i < count; i++) {
    const amount = amounts[i]!;
    if (amount <= 0n) {
      throw new RangeError(`revenue ${ids[i]} has non-positive amount`);
    }
    totalAmount += amount;
  }

  const floors = new BigInt64Array(count);
  const remainders = new BigInt64Array(count);
  let floorSum = 0n;
  for (let i = 0; i < count; i++) {
    const product = fixedCost * amounts[i]!;
    const floor = product / totalAmount;
    floors[i] = floor;
    remainders[i] = product % totalAmount;
    floorSum += floor;
  }

  // 需要补 1 分的笔数 = 固定成本减去所有向下取整之和（必然 < 收入笔数）。
  const bumpCount = Number(fixedCost - floorSum);
  if (bumpCount > 0) {
    // 余数降序、编号升序，对下标排序以避免拷贝大数组。
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      order[i] = i;
    }
    order.sort((a, b) => {
      const ra = remainders[a]!;
      const rb = remainders[b]!;
      if (ra > rb) return -1;
      if (ra < rb) return 1;
      const ia = ids[a]!;
      const ib = ids[b]!;
      if (ia < ib) return -1;
      if (ia > ib) return 1;
      return 0;
    });
    for (let i = 0; i < bumpCount; i++) {
      const idx = order[i]!;
      floors[idx] = floors[idx]! + 1n;
    }
  }
  allocated.set(floors);
  return allocated;
}
