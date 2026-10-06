import { ComponentInfo } from './types.js';

/**
 * 动态等价组维护：支持建立/撤销直接引用（带删除的动态连通性）。
 * 节点为从 0 开始的连续整数编号，由 addNode 分配。
 *
 * 实现要点：
 * - 每个节点记录当前等价组编号；每个等价组记录成员数与各仓库库存汇总。
 * - 合并时把较小的组重新编号进较大的组（按组大小均摊 O(n log n)）。
 * - 撤销边时用双向 BFS 判断两端是否仍连通：仍连通则不动；
 *   不连通时先耗尽的一侧必为较小侧，将其整体切分为新组并同步库存汇总。
 */
export class ComponentGraph {
  private readonly adj: Array<Set<number>> = [];
  private readonly comp: number[] = [];
  private readonly toComp = new Map<number, ComponentInfo>();
  /** 每个节点的库存：内部仓库编号 -> 可用量（只存非零项）。 */
  private readonly nodeStock: Array<Map<number, number>> = [];
  /** 双向 BFS 的访问标记，用戳值避免每次分配新数组。 */
  private visitMark: Int32Array = new Int32Array(0);
  private visitStamp = 0;
  private nextCompId = 0;

  /** 注册一个新节点，返回其内部编号。新节点自成一组。 */
  addNode(): number {
    const id = this.adj.length;
    this.adj.push(new Set());
    this.comp.push(this.nextCompId);
    this.toComp.set(this.nextCompId, { size: 1, stock: new Map() });
    this.nextCompId += 1;
    this.nodeStock.push(new Map());
    return id;
  }

  /** 建立两个节点之间的直接引用；已存在或自引用时不改变状态。 */
  link(a: number, b: number): void {
    if (a === b || this.adj[a].has(b)) return;
    this.adj[a].add(b);
    this.adj[b].add(a);
    const compA = this.comp[a];
    const compB = this.comp[b];
    if (compA === compB) return;
    const infoA = this.toComp.get(compA)!;
    const infoB = this.toComp.get(compB)!;
    // 小组并入大组。
    const smallId = infoA.size <= infoB.size ? compA : compB;
    const bigId = infoA.size <= infoB.size ? compB : compA;
    const smallInfo = this.toComp.get(smallId)!;
    const bigInfo = this.toComp.get(bigId)!;
    // BFS 遍历小组全部节点，重新编号。
    const queue: number[] = [this.comp[a] === smallId ? a : b];
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head];
      if (this.comp[node] !== smallId) continue;
      this.comp[node] = bigId;
      for (const next of this.adj[node]) {
        if (this.comp[next] === smallId) queue.push(next);
      }
    }
    // 合并库存汇总。
    for (const [wh, qty] of smallInfo.stock) {
      bigInfo.stock.set(wh, (bigInfo.stock.get(wh) ?? 0) + qty);
    }
    bigInfo.size += smallInfo.size;
    this.toComp.delete(smallId);
  }

  /** 撤销两个节点之间的直接引用；关系不存在时不改变状态。 */
  unlink(a: number, b: number): void {
    if (a === b || !this.adj[a].has(b)) return;
    this.adj[a].delete(b);
    this.adj[b].delete(a);
    const compId = this.comp[a];
    if (compId !== this.comp[b]) return; // 防御性判断：正常流程下两端必同组。

    // 双向 BFS：从 a、b 两侧交替扩展较小 frontier。
    this.visitStamp += 2;
    if (this.visitStamp >= 0x7ffffff0) {
      this.visitMark.fill(0);
      this.visitStamp = 2;
    }
    const stampA = this.visitStamp - 1;
    const stampB = this.visitStamp;
    if (this.visitMark.length < this.adj.length) {
      const grown = new Int32Array(this.adj.length);
      grown.set(this.visitMark);
      this.visitMark = grown;
    }
    const mark = this.visitMark;
    let queueA: number[] = [a];
    let queueB: number[] = [b];
    mark[a] = stampA;
    mark[b] = stampB;
    // A 侧扩展时收集的节点，仅在 A 侧先耗尽（A 为较小连通块）时用于切分。
    const sideA: number[] = [];

    while (queueA.length > 0 && queueB.length > 0) {
      // 总是扩展较小的一侧，保证先耗尽的一侧是不大于另一侧的连通块。
      const expandA = queueA.length <= queueB.length;
      const queue = expandA ? queueA : queueB;
      const ownStamp = expandA ? stampA : stampB;
      const otherStamp = expandA ? stampB : stampA;
      const nextQueue: number[] = [];
      for (const node of queue) {
        for (const next of this.adj[node]) {
          const m = mark[next];
          if (m === otherStamp) {
            // 两侧相遇：删边后仍连通，分组不变。
            return;
          }
          if (m !== ownStamp) {
            mark[next] = ownStamp;
            nextQueue.push(next);
            if (expandA) sideA.push(next);
          }
        }
      }
      if (expandA) queueA = nextQueue;
      else queueB = nextQueue;
    }

    // 先耗尽的一侧构成完整连通块，且不大于另一侧，将其切分为新组。
    const members =
      queueA.length === 0
        ? (sideA.push(a), sideA)
        : this.collectMarked(b, stampB);
    this.splitComponent(compId, members);
  }

  /** 收集所有带指定标记、且与 start 连通的节点（含 start）。 */
  private collectMarked(start: number, stamp: number): number[] {
    const mark = this.visitMark;
    mark[start] = 0; // 清除起点标记，防止它被邻居重复收集
    const members = [start];
    for (let head = 0; head < members.length; head += 1) {
      const node = members[head];
      for (const next of this.adj[node]) {
        if (mark[next] === stamp) {
          mark[next] = 0; // 防止重复入队
          members.push(next);
        }
      }
    }
    return members;
  }

  /** 把 members 从 oldCompId 中切出，成立新组并同步库存汇总。 */
  private splitComponent(oldCompId: number, members: number[]): void {
    const oldInfo = this.toComp.get(oldCompId)!;
    const newCompId = this.nextCompId;
    this.nextCompId += 1;
    const newInfo: ComponentInfo = { size: members.length, stock: new Map() };
    for (const node of members) {
      this.comp[node] = newCompId;
      for (const [wh, qty] of this.nodeStock[node]) {
        newInfo.stock.set(wh, (newInfo.stock.get(wh) ?? 0) + qty);
      }
    }
    for (const [wh, qty] of newInfo.stock) {
      const remain = (oldInfo.stock.get(wh) ?? 0) - qty;
      if (remain === 0) oldInfo.stock.delete(wh);
      else oldInfo.stock.set(wh, remain);
    }
    oldInfo.size -= newInfo.size;
    this.toComp.set(newCompId, newInfo);
  }

  /** 设置节点在某仓库的可用量（内部编号），同步组级汇总。 */
  setStock(node: number, warehouse: number, qty: number): void {
    const stock = this.nodeStock[node];
    const old = stock.get(warehouse) ?? 0;
    if (old === qty) return;
    if (qty === 0) stock.delete(warehouse);
    else stock.set(warehouse, qty);
    const info = this.toComp.get(this.comp[node])!;
    const total = (info.stock.get(warehouse) ?? 0) + qty - old;
    if (total === 0) info.stock.delete(warehouse);
    else info.stock.set(warehouse, total);
  }

  /** 节点当前所属等价组的内部编号。 */
  componentOf(node: number): number {
    return this.comp[node];
  }

  /** 等价组信息（size 与组级库存汇总），内部对象，调用方不得修改。 */
  componentInfo(comp: number): ComponentInfo {
    return this.toComp.get(comp)!;
  }
}
