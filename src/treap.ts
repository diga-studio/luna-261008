/**
 * 按 (closeDateKey, externalId) 排序的 Treap，子树聚合 amountCents 之和（BigInt）。
 * 插入、删除、前缀和查询均为期望 O(log n)，节点总数随成交数线性增长。
 */
export interface TreapNode {
  readonly dateKey: number;
  readonly externalId: string;
  amountCents: bigint;
  priority: number;
  left: TreapNode | null;
  right: TreapNode | null;
  subtreeSum: bigint;
}

function compareKeys(aDate: number, aId: string, bDate: number, bId: string): number {
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

function subtreeSumOf(node: TreapNode | null): bigint {
  return node === null ? 0n : node.subtreeSum;
}

function pull(node: TreapNode): void {
  node.subtreeSum = subtreeSumOf(node.left) + node.amountCents + subtreeSumOf(node.right);
}

function rotateRight(node: TreapNode): TreapNode {
  const child = node.left!;
  node.left = child.right;
  child.right = node;
  pull(node);
  pull(child);
  return child;
}

function rotateLeft(node: TreapNode): TreapNode {
  const child = node.right!;
  node.right = child.left;
  child.left = node;
  pull(node);
  pull(child);
  return child;
}

/** 可复现的伪随机优先级生成器（xorshift32）。 */
export class PriorityRandom {
  private state: number;
  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
}

export class DealTreap {
  root: TreapNode | null = null;
  size = 0;
  private readonly random: PriorityRandom;

  constructor(random: PriorityRandom = new PriorityRandom()) {
    this.random = random;
  }

  insert(dateKey: number, externalId: string, amountCents: bigint): void {
    const node: TreapNode = {
      dateKey,
      externalId,
      amountCents,
      priority: this.random.next(),
      left: null,
      right: null,
      subtreeSum: amountCents,
    };
    this.root = this.insertNode(this.root, node);
    this.size += 1;
  }

  private insertNode(root: TreapNode | null, node: TreapNode): TreapNode {
    if (root === null) return node;
    const cmp = compareKeys(node.dateKey, node.externalId, root.dateKey, root.externalId);
    if (cmp < 0) {
      root.left = this.insertNode(root.left, node);
      pull(root);
      return root.left!.priority < root.priority ? rotateRight(root) : root;
    }
    root.right = this.insertNode(root.right, node);
    pull(root);
    return root.right!.priority < root.priority ? rotateLeft(root) : root;
  }

  remove(dateKey: number, externalId: string): void {
    this.root = this.removeNode(this.root, dateKey, externalId);
    this.size -= 1;
  }

  private removeNode(root: TreapNode | null, dateKey: number, externalId: string): TreapNode | null {
    if (root === null) throw new Error("removeNode: key not found");
    const cmp = compareKeys(dateKey, externalId, root.dateKey, root.externalId);
    if (cmp < 0) {
      root.left = this.removeNode(root.left, dateKey, externalId);
      pull(root);
      return root;
    }
    if (cmp > 0) {
      root.right = this.removeNode(root.right, dateKey, externalId);
      pull(root);
      return root;
    }
    return this.merge(root.left, root.right);
  }

  private merge(left: TreapNode | null, right: TreapNode | null): TreapNode | null {
    if (left === null) return right;
    if (right === null) return left;
    if (left.priority < right.priority) {
      left.right = this.merge(left.right, right);
      pull(left);
      return left;
    }
    right.left = this.merge(left, right.left);
    pull(right);
    return right;
  }

  /** 严格排在 (dateKey, externalId) 之前的所有节点的 amountCents 之和。 */
  prefixSumBefore(dateKey: number, externalId: string): bigint {
    let total = 0n;
    let node = this.root;
    while (node !== null) {
      const cmp = compareKeys(dateKey, externalId, node.dateKey, node.externalId);
      if (cmp <= 0) {
        node = node.left;
      } else {
        total += subtreeSumOf(node.left) + node.amountCents;
        node = node.right;
      }
    }
    return total;
  }
}
