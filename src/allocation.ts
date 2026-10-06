/** 成本池内一笔参与分摊的收入。 */
export interface PoolRevenue {
  id: bigint;
  amountCents: bigint;
}

/**
 * 可复用缓冲区的成本池分摊器。
 * 反复调用 reset/add/compute 不会重新分配大数组，适合大池高频重算。
 * 注意：compute 返回的数组是内部缓冲，下次 reset 前有效。
 */
export class PoolAllocator {
  private ids: bigint[] = [];
  private amounts: bigint[] = [];
  private remainders: bigint[] = [];
  private allocated: bigint[] = [];
  private order: Uint32Array = new Uint32Array(0);
  private count = 0;

  /** 清空池，准备接收新一轮收入。 */
  reset(): void {
    this.count = 0;
  }

  /** 向池中加入一笔收入。 */
  add(id: bigint, amountCents: bigint): void {
    const i = this.count++;
    if (i >= this.ids.length) {
      // 倍增扩容，避免大池反复分配
      const cap = Math.max(1024, this.ids.length * 2);
      this.ids.length = cap;
      this.amounts.length = cap;
      this.remainders.length = cap;
      this.allocated.length = cap;
    }
    this.ids[i] = id;
    this.amounts[i] = amountCents;
  }

  /** 当前池内收入笔数。 */
  get size(): number {
    return this.count;
  }

  /** 第 i 笔收入的编号（与 add 顺序一致）。 */
  idAt(index: number): bigint {
    return this.ids[index]!;
  }

  /**
   * 计算整分分摊，返回与 add 顺序一致的分摊金额数组。
   * 返回的是内部缓冲（仅前 size 项有效），下次 reset/compute 前有效。
   * 规则：精确理论份额 floor(池金额 * 收入额 / 池收入总额)；
   * 剩余分数按“小数部分大者优先、并列时编号小者优先”逐个补 1 分；
   * 分摊之和恰好等于池金额。
   */
  compute(poolAmountCents: bigint): readonly bigint[] {
    const n = this.count;
    const { ids, amounts, remainders, allocated } = this;

    let totalAmount = 0n;
    for (let i = 0; i < n; i++) totalAmount += amounts[i]!;

    let floorSum = 0n;
    for (let i = 0; i < n; i++) {
      const share = poolAmountCents * amounts[i]!;
      const floor = share / totalAmount;
      allocated[i] = floor;
      remainders[i] = share % totalAmount;
      floorSum += floor;
    }

    // 需要补 1 分的笔数（恒小于收入笔数）
    let need = poolAmountCents - floorSum;

    if (this.order.length < n) this.order = new Uint32Array(Math.max(1024, n));
    const order = this.order;
    for (let i = 0; i < n; i++) order[i] = i;
    const sorted = order.subarray(0, n);
    sorted.sort((a, b) => {
      const ra = remainders[a]!;
      const rb = remainders[b]!;
      if (ra !== rb) return ra > rb ? -1 : 1;
      const ida = ids[a]!;
      const idb = ids[b]!;
      return ida < idb ? -1 : ida > idb ? 1 : 0;
    });

    for (let k = 0; k < n && need > 0n; k++) {
      const idx = sorted[k]!;
      allocated[idx] = allocated[idx]! + 1n;
      need -= 1n;
    }
    return allocated;
  }
}

/**
 * 计算一个成本池的整分分摊结果（便捷封装，返回新数组）。
 * 返回与 revenues 同序的分摊金额数组（分），规则见 PoolAllocator.compute。
 */
export function allocatePool(
  poolAmountCents: bigint,
  revenues: readonly PoolRevenue[],
): bigint[] {
  const allocator = new PoolAllocator();
  for (const r of revenues) allocator.add(r.id, r.amountCents);
  const allocated = allocator.compute(poolAmountCents);
  return allocated.slice(0, revenues.length);
}
