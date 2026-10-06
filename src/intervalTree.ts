/**
 * 区间索引：以 (start, key) 排序的 treap，子树维护 maxEnd。
 * insert/remove 期望 O(log n)，queryOverlaps 期望 O(log n + k)。
 * 同一 key 的 (start, end) 唯一；key 用严格弱序比较。
 */

export type Compare<K> = (a: K, b: K) => number;

interface Node<K> {
  key: K;
  start: number;
  end: number;
  prio: number;
  maxEnd: number;
  left: Node<K> | null;
  right: Node<K> | null;
}

function maxOf<K>(n: Node<K> | null): number {
  return n === null ? -Infinity : n.maxEnd;
}

function pull<K>(n: Node<K>): void {
  n.maxEnd = Math.max(n.end, maxOf(n.left), maxOf(n.right));
}

function rotateRight<K>(n: Node<K>): Node<K> {
  const l = n.left!;
  n.left = l.right;
  l.right = n;
  pull(n);
  pull(l);
  return l;
}

function rotateLeft<K>(n: Node<K>): Node<K> {
  const r = n.right!;
  n.right = r.left;
  r.left = n;
  pull(n);
  pull(r);
  return r;
}

export class IntervalTree<K> {
  private root: Node<K> | null = null;
  private size_ = 0;
  private readonly cmp: Compare<K>;

  constructor(cmp: Compare<K>) {
    this.cmp = cmp;
  }

  get size(): number {
    return this.size_;
  }

  insert(key: K, start: number, end: number): void {
    this.root = this.insertNode(this.root, {
      key, start, end,
      prio: Math.random(),
      maxEnd: end,
      left: null,
      right: null,
    });
    this.size_++;
  }

  private insertNode(n: Node<K> | null, node: Node<K>): Node<K> {
    if (n === null) return node;
    const c = this.compare(node, n);
    if (c < 0) {
      n.left = this.insertNode(n.left, node);
      if (n.left!.prio < n.prio) return rotateRight(n);
    } else {
      n.right = this.insertNode(n.right, node);
      if (n.right!.prio < n.prio) return rotateLeft(n);
    }
    pull(n);
    return n;
  }

  private removedFlag = false;

  remove(key: K, start: number): void {
    this.removedFlag = false;
    this.root = this.removeNode(this.root, key, start);
    if (!this.removedFlag) {
      throw new Error('IntervalTree.remove: key not found');
    }
    this.size_--;
  }

  private removeNode(n: Node<K> | null, key: K, start: number): Node<K> | null {
    if (n === null) return null;
    const c = this.compareKey(key, start, n);
    if (c < 0) {
      n.left = this.removeNode(n.left, key, start);
    } else if (c > 0) {
      n.right = this.removeNode(n.right, key, start);
    } else {
      this.removedFlag = true;
      if (n.left === null) return n.right;
      if (n.right === null) return n.left;
      if (n.left.prio < n.right.prio) {
        const r = rotateRight(n);
        r.right = this.removeNode(n, key, start);
        pull(r);
        return r;
      } else {
        const l = rotateLeft(n);
        l.left = this.removeNode(n, key, start);
        pull(l);
        return l;
      }
    }
    pull(n);
    return n;
  }

  /** 枚举所有与 [start, end) 重叠的区间；visit 返回 false 时提前终止。 */
  queryOverlaps(start: number, end: number, visit: (key: K) => boolean | void): void {
    this.query(this.root, start, end, visit);
  }

  private query(n: Node<K> | null, qs: number, qe: number, visit: (key: K) => boolean | void): boolean {
    if (n === null) return true;
    // 左子树中存在 end > qs 的区间才需要进入
    if (n.left !== null && n.left.maxEnd > qs) {
      if (!this.query(n.left, qs, qe, visit)) return false;
    }
    if (n.start < qe && n.end > qs) {
      if (visit(n.key) === false) return false;
    }
    // 当前节点 start >= qe 时，右子树所有 start 也 >= qe，不可能重叠
    if (n.start < qe && n.right !== null && n.right.maxEnd > qs) {
      if (!this.query(n.right, qs, qe, visit)) return false;
    }
    return true;
  }

  private compare(a: { key: K; start: number }, b: { key: K; start: number }): number {
    if (a.start !== b.start) return a.start - b.start;
    return this.cmp(a.key, b.key);
  }

  private compareKey(key: K, start: number, n: Node<K>): number {
    if (start !== n.start) return start - n.start;
    return this.cmp(key, n.key);
  }
}
