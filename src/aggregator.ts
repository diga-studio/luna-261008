import type { GroupSummary, SkuId, WarehouseId } from "./types";

interface Group {
  /** 组内 SKU 的内部索引。 */
  members: Set<number>;
  /** 按仓库内部索引存放的可用量总和。 */
  totals: number[];
}

/**
 * 替代件库存汇总库。
 *
 * 维护 SKU 之间双向、可传递的等价关系（交叉引用），
 * 并按等价组汇总各仓库可用量。所有数据保存在进程内。
 *
 * 内部把 SKU / 仓库标识映射为连续整数，邻接表与库存都按整数
 * 索引存放，保证大规模数据下的耗时与内存可控。
 */
export class InventoryAggregator {
  private readonly skuIds = new Map<SkuId, number>();
  private readonly adj: Array<Set<number>> = [];
  private readonly groupOf: number[] = [];
  private readonly stock: Array<Map<number, number>> = [];

  private readonly groups = new Map<number, Group>();
  private nextGroupId = 0;

  private readonly whIds = new Map<WarehouseId, number>();
  private readonly whNames: WarehouseId[] = [];

  /** 建立两个 SKU 之间的直接引用；已存在时不改变状态。 */
  link(a: SkuId, b: SkuId): void {
    const ia = this.ensureSku(a);
    const ib = this.ensureSku(b);
    if (ia === ib) return;
    const adjA = this.adj[ia];
    if (adjA.has(ib)) return;
    adjA.add(ib);
    this.adj[ib].add(ia);

    const ga = this.groupOf[ia];
    const gb = this.groupOf[ib];
    if (ga === gb) return;
    this.mergeGroups(ga, gb);
  }

  /** 撤销两个 SKU 之间的直接引用；不存在时不改变状态。 */
  unlink(a: SkuId, b: SkuId): void {
    const ia = this.skuIds.get(a);
    const ib = this.skuIds.get(b);
    if (ia === undefined || ib === undefined || ia === ib) return;
    if (!this.adj[ia].has(ib)) return;
    this.adj[ia].delete(ib);
    this.adj[ib].delete(ia);
    this.splitIfDisconnected(ia, ib);
  }

  /** 覆盖设置一个 SKU 在一个仓库的可用量（非负整数）。 */
  setStock(sku: SkuId, warehouse: WarehouseId, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new RangeError(`quantity must be a non-negative integer, got ${quantity}`);
    }
    const idx = this.ensureSku(sku);
    const w = this.ensureWarehouse(warehouse);
    const entry = this.stock[idx];
    const old = entry.get(w) ?? 0;
    if (old === quantity) return;
    if (quantity === 0) {
      entry.delete(w);
    } else {
      entry.set(w, quantity);
    }
    const group = this.groups.get(this.groupOf[idx]);
    if (group !== undefined) {
      group.totals[w] += quantity - old;
    }
  }

  /** 查询一个 SKU 所属等价组的汇总。 */
  query(sku: SkuId): GroupSummary {
    const idx = this.skuIds.get(sku);
    if (idx === undefined) {
      return { skuCount: 1, totals: new Map() };
    }
    const group = this.groups.get(this.groupOf[idx]);
    if (group === undefined) {
      return { skuCount: 1, totals: new Map() };
    }
    const totals = new Map<WarehouseId, number>();
    for (let w = 0; w < group.totals.length; w++) {
      const value = group.totals[w];
      if (value !== 0) {
        totals.set(this.whNames[w], value);
      }
    }
    return { skuCount: group.members.size, totals };
  }

  private ensureSku(id: SkuId): number {
    let idx = this.skuIds.get(id);
    if (idx === undefined) {
      idx = this.skuIds.size;
      this.skuIds.set(id, idx);
      this.adj.push(new Set());
      this.stock.push(new Map());
      const groupId = this.nextGroupId++;
      this.groupOf.push(groupId);
      this.groups.set(groupId, {
        members: new Set([idx]),
        totals: new Array<number>(this.whNames.length).fill(0),
      });
    }
    return idx;
  }

  private ensureWarehouse(id: WarehouseId): number {
    let idx = this.whIds.get(id);
    if (idx === undefined) {
      idx = this.whNames.length;
      this.whIds.set(id, idx);
      this.whNames.push(id);
      for (const group of this.groups.values()) {
        group.totals.push(0);
      }
    }
    return idx;
  }

  /** 把较小的组合并进较大的组。 */
  private mergeGroups(ga: number, gb: number): void {
    let groupA = this.groups.get(ga);
    let groupB = this.groups.get(gb);
    if (groupA === undefined || groupB === undefined) return;
    if (groupB.members.size > groupA.members.size) {
      const tmpGroup = groupA;
      groupA = groupB;
      groupB = tmpGroup;
      const tmpId = ga;
      ga = gb;
      gb = tmpId;
    }
    for (const member of groupB.members) {
      this.groupOf[member] = ga;
      groupA.members.add(member);
    }
    for (let w = 0; w < groupA.totals.length; w++) {
      groupA.totals[w] += groupB.totals[w];
    }
    this.groups.delete(gb);
  }

  /**
   * 删除边 (ia, ib) 后，从两端做双向 BFS（每轮扩展较小的一侧）。
   * 若两侧相遇则组仍连通；若某一侧先遍历完，则该侧构成新的组。
   */
  private splitIfDisconnected(ia: number, ib: number): void {
    const visitedA = new Set<number>([ia]);
    const visitedB = new Set<number>([ib]);
    let frontierA = [ia];
    let frontierB = [ib];

    for (;;) {
      if (frontierA.length === 0) {
        this.detachGroup(visitedA);
        return;
      }
      if (frontierB.length === 0) {
        this.detachGroup(visitedB);
        return;
      }
      const expandA = frontierA.length <= frontierB.length;
      const frontier = expandA ? frontierA : frontierB;
      const visited = expandA ? visitedA : visitedB;
      const other = expandA ? visitedB : visitedA;
      const next: number[] = [];
      for (const node of frontier) {
        for (const neighbor of this.adj[node]) {
          if (other.has(neighbor)) return; // 仍连通
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      if (expandA) {
        frontierA = next;
      } else {
        frontierB = next;
      }
    }
  }

  /** 把 members 从当前所在组中分离为一个新组。 */
  private detachGroup(members: Set<number>): void {
    const first = members.values().next().value as number;
    const oldGroup = this.groups.get(this.groupOf[first]);
    const newGroupId = this.nextGroupId++;
    const totals = new Array<number>(this.whNames.length).fill(0);
    for (const member of members) {
      this.groupOf[member] = newGroupId;
      oldGroup?.members.delete(member);
      for (const [w, qty] of this.stock[member]) {
        totals[w] += qty;
      }
    }
    if (oldGroup !== undefined) {
      for (let w = 0; w < totals.length; w++) {
        oldGroup.totals[w] -= totals[w];
      }
    }
    this.groups.set(newGroupId, { members, totals });
  }
}
