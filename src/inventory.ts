import { ComponentGraph } from './graph.js';
import { GroupSummary } from './types.js';

/**
 * 替代件库存汇总库。数据保存在进程内，由调用方串行调用。
 * SKU 与仓库均使用调用方提供的字符串标识，首次出现时自动登记。
 */
export class PartsInventory {
  private readonly graph = new ComponentGraph();
  private readonly skuToNode = new Map<string, number>();
  private readonly whToId = new Map<string, number>();
  private readonly whNames: string[] = [];

  /** 建立两个 SKU 之间的直接交叉引用（双向、可传递）。重复建立不改变状态。 */
  link(skuA: string, skuB: string): void {
    this.graph.link(this.nodeOf(skuA), this.nodeOf(skuB));
  }

  /** 撤销两个 SKU 之间的直接引用。撤销不存在的关系不改变状态。 */
  unlink(skuA: string, skuB: string): void {
    const a = this.skuToNode.get(skuA);
    const b = this.skuToNode.get(skuB);
    if (a === undefined || b === undefined) return; // 任一端未登记，关系必不存在。
    this.graph.unlink(a, b);
  }

  /** 设置一个 SKU 在一个仓库的可用量（覆盖旧值，必须是非负整数）。 */
  setStock(sku: string, warehouse: string, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new RangeError(`quantity must be a non-negative integer, got ${quantity}`);
    }
    this.graph.setStock(this.nodeOf(sku), this.whIdOf(warehouse), quantity);
  }

  /** 查询一个 SKU 所属等价组的库存汇总。 */
  query(sku: string): GroupSummary {
    const node = this.skuToNode.get(sku);
    if (node === undefined) {
      // 从未登记的 SKU：自成一组且无库存，不为其分配内部状态。
      return { skuCount: 1, stock: {} };
    }
    const info = this.graph.componentInfo(this.graph.componentOf(node));
    const stock: Record<string, number> = {};
    for (const [wh, qty] of info.stock) {
      stock[this.whNames[wh]] = qty;
    }
    return { skuCount: info.size, stock };
  }

  /** 登记 SKU（如未登记）并返回内部节点编号。 */
  private nodeOf(sku: string): number {
    let node = this.skuToNode.get(sku);
    if (node === undefined) {
      node = this.graph.addNode();
      this.skuToNode.set(sku, node);
    }
    return node;
  }

  /** 登记仓库（如未登记）并返回内部编号。 */
  private whIdOf(warehouse: string): number {
    let id = this.whToId.get(warehouse);
    if (id === undefined) {
      id = this.whNames.length;
      this.whNames.push(warehouse);
      this.whToId.set(warehouse, id);
    }
    return id;
  }
}
