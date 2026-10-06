/**
 * 单个资源（某教师/场地/学员）的场次区间索引。
 *
 * 实现为带 maxEnd 子树增强的 treap（期望平衡）：
 *  - BST 键为 (start, sessionId)，每个场次在同一资源下只有一条区间；
 *  - 堆序由随机优先级维持，insert/remove 期望 O(log n)；
 *  - maxEnd 增强使重叠查询可以整子树剪枝，代价 O(log n + k)。
 *
 * 更新只触及根到目标节点的路径，不会扫描或搬移整个资源日历。
 */
interface Node {
  sessionId: string;
  start: number;
  end: number;
  maxEnd: number;
  priority: number;
  left: Node | undefined;
  right: Node | undefined;
}

function compareKey(startA: number, idA: string, startB: number, idB: string): number {
  if (startA !== startB) return startA < startB ? -1 : 1;
  if (idA === idB) return 0;
  return idA < idB ? -1 : 1;
}

function pull(node: Node): void {
  let maxEnd = node.end;
  if (node.left !== undefined && node.left.maxEnd > maxEnd) maxEnd = node.left.maxEnd;
  if (node.right !== undefined && node.right.maxEnd > maxEnd) maxEnd = node.right.maxEnd;
  node.maxEnd = maxEnd;
}

function rotateRight(node: Node): Node {
  const child = node.left as Node;
  node.left = child.right;
  child.right = node;
  pull(node);
  pull(child);
  return child;
}

function rotateLeft(node: Node): Node {
  const child = node.right as Node;
  node.right = child.left;
  child.left = node;
  pull(node);
  pull(child);
  return child;
}

export class IntervalIndex {
  private root: Node | undefined = undefined;
  private count = 0;

  get size(): number {
    return this.count;
  }

  insert(sessionId: string, start: number, end: number): void {
    this.root = this.insertNode(this.root, {
      sessionId,
      start,
      end,
      maxEnd: end,
      priority: Math.random(),
      left: undefined,
      right: undefined,
    });
    this.count += 1;
  }

  private insertNode(root: Node | undefined, node: Node): Node {
    if (root === undefined) return node;
    if (compareKey(node.start, node.sessionId, root.start, root.sessionId) < 0) {
      root.left = this.insertNode(root.left, node);
      pull(root);
      if ((root.left as Node).priority < root.priority) return rotateRight(root);
      return root;
    }
    root.right = this.insertNode(root.right, node);
    pull(root);
    if ((root.right as Node).priority < root.priority) return rotateLeft(root);
    return root;
  }

  /** 删除指定区间。调用方必须提供该场次当前记录中的 start（键的一部分）。 */
  remove(sessionId: string, start: number): void {
    const [root, removed] = this.removeNode(this.root, sessionId, start);
    this.root = root;
    if (removed) this.count -= 1;
  }

  private removeNode(
    root: Node | undefined,
    sessionId: string,
    start: number,
  ): [Node | undefined, boolean] {
    if (root === undefined) return [undefined, false];
    const cmp = compareKey(start, sessionId, root.start, root.sessionId);
    if (cmp < 0) {
      const [left, removed] = this.removeNode(root.left, sessionId, start);
      root.left = left;
      pull(root);
      return [root, removed];
    }
    if (cmp > 0) {
      const [right, removed] = this.removeNode(root.right, sessionId, start);
      root.right = right;
      pull(root);
      return [root, removed];
    }
    if (root.left === undefined) return [root.right, true];
    if (root.right === undefined) return [root.left, true];
    if (root.left.priority < root.right.priority) {
      const rotated = rotateRight(root);
      const [right, removed] = this.removeNode(rotated.right, sessionId, start);
      rotated.right = right;
      pull(rotated);
      return [rotated, removed];
    }
    const rotated = rotateLeft(root);
    const [left, removed] = this.removeNode(rotated.left, sessionId, start);
    rotated.left = left;
    pull(rotated);
    return [rotated, removed];
  }

  /**
   * 对所有与 [start, end) 重叠（左闭右开，首尾相接不算重叠）的区间调用 visit。
   * skip 中的 sessionId 被忽略（用于排除批次内场次的旧区间）。
   */
  forEachOverlap(
    start: number,
    end: number,
    skip: ReadonlySet<string> | null,
    visit: (sessionId: string, start: number, end: number) => void,
  ): void {
    this.query(this.root, start, end, skip, visit);
  }

  private query(
    node: Node | undefined,
    start: number,
    end: number,
    skip: ReadonlySet<string> | null,
    visit: (sessionId: string, start: number, end: number) => void,
  ): void {
    if (node === undefined) return;
    if (node.maxEnd <= start) return; // 整棵子树都在 start 之前结束
    this.query(node.left, start, end, skip, visit);
    if (node.start >= end) return; // 右子树 start 均 >= 当前节点，不可能重叠
    if (node.end > start && (skip === null || !skip.has(node.sessionId))) {
      visit(node.sessionId, node.start, node.end);
    }
    this.query(node.right, start, end, skip, visit);
  }
}
