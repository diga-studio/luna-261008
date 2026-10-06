/**
 * 随机化 Treap：按 compare(key) 全序排列的顺序统计树。
 * 子树聚合 amount 之和（BigInt）与节点数，所有操作期望 O(log n)。
 */
export interface TreapNode<K> {
  key: K;
  amount: bigint;
  priority: number;
  left: TreapNode<K> | null;
  right: TreapNode<K> | null;
  subtreeSum: bigint;
  subtreeCount: number;
}

function pull<K>(node: TreapNode<K>): void {
  let sum = node.amount;
  let count = 1;
  if (node.left !== null) {
    sum += node.left.subtreeSum;
    count += node.left.subtreeCount;
  }
  if (node.right !== null) {
    sum += node.right.subtreeSum;
    count += node.right.subtreeCount;
  }
  node.subtreeSum = sum;
  node.subtreeCount = count;
}

function rotateRight<K>(node: TreapNode<K>): TreapNode<K> {
  const child = node.left as TreapNode<K>;
  node.left = child.right;
  child.right = node;
  pull(node);
  pull(child);
  return child;
}

function rotateLeft<K>(node: TreapNode<K>): TreapNode<K> {
  const child = node.right as TreapNode<K>;
  node.right = child.left;
  child.left = node;
  pull(node);
  pull(child);
  return child;
}

export class OrderStatisticTree<K> {
  private root: TreapNode<K> | null = null;
  private nodeCount = 0;

  constructor(
    private readonly compare: (a: K, b: K) => number,
    private readonly rand: () => number,
  ) {}

  get size(): number {
    return this.nodeCount;
  }

  upsert(key: K, amount: bigint): void {
    const [node, inserted] = this.upsertRec(this.root, key, amount);
    this.root = node;
    if (inserted) this.nodeCount += 1;
  }

  private upsertRec(
    node: TreapNode<K> | null,
    key: K,
    amount: bigint,
  ): [TreapNode<K>, boolean] {
    if (node === null) {
      return [
        {
          key,
          amount,
          priority: this.rand(),
          left: null,
          right: null,
          subtreeSum: amount,
          subtreeCount: 1,
        },
        true,
      ];
    }
    const cmp = this.compare(key, node.key);
    if (cmp === 0) {
      node.amount = amount;
      pull(node);
      return [node, false];
    }
    let inserted: boolean;
    if (cmp < 0) {
      [node.left, inserted] = this.upsertRec(node.left, key, amount);
      pull(node);
      if (node.left !== null && node.left.priority < node.priority) {
        return [rotateRight(node), inserted];
      }
    } else {
      [node.right, inserted] = this.upsertRec(node.right, key, amount);
      pull(node);
      if (node.right !== null && node.right.priority < node.priority) {
        return [rotateLeft(node), inserted];
      }
    }
    return [node, inserted];
  }

  remove(key: K): void {
    const [node, removed] = this.removeRec(this.root, key);
    if (!removed) {
      throw new Error("key not found");
    }
    this.root = node;
    this.nodeCount -= 1;
  }

  private removeRec(
    node: TreapNode<K> | null,
    key: K,
  ): [TreapNode<K> | null, boolean] {
    if (node === null) {
      return [null, false];
    }
    const cmp = this.compare(key, node.key);
    if (cmp === 0) {
      return [this.merge(node.left, node.right), true];
    }
    let removed: boolean;
    if (cmp < 0) {
      [node.left, removed] = this.removeRec(node.left, key);
    } else {
      [node.right, removed] = this.removeRec(node.right, key);
    }
    if (removed) pull(node);
    return [node, removed];
  }

  private merge(
    left: TreapNode<K> | null,
    right: TreapNode<K> | null,
  ): TreapNode<K> | null {
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

  has(key: K): boolean {
    let node = this.root;
    while (node !== null) {
      const cmp = this.compare(key, node.key);
      if (cmp === 0) return true;
      node = cmp < 0 ? node.left : node.right;
    }
    return false;
  }

  /** 严格小于 key 的所有节点的 amount 之和。 */
  sumBefore(key: K): bigint {
    let sum = 0n;
    let node = this.root;
    while (node !== null) {
      const cmp = this.compare(key, node.key);
      if (cmp <= 0) {
        node = node.left;
      } else {
        sum += (node.left === null ? 0n : node.left.subtreeSum) + node.amount;
        node = node.right;
      }
    }
    return sum;
  }
}
