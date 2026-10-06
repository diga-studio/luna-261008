/**
 * 有序统计树（Treap）：按 (priority, seq) 排序的键维护子树大小与耗时和，
 * 支持 O(log n) 的插入、删除与前缀统计。每台印机一棵。
 */

/** 排序键：priority 小的在前；同级按 seq（入队先后）小的在前。 */
export interface TreapKey {
  readonly priority: number;
  readonly seq: number;
}

export interface TreapNode {
  key: TreapKey;
  /** 该作业耗时（秒）。 */
  duration: number;
  heap: number;
  left: TreapNode | null;
  right: TreapNode | null;
  /** 子树节点数。 */
  size: number;
  /** 子树耗时和（秒）。 */
  sum: number;
}

export interface PrefixStat {
  /** 严格排在 key 之前的作业数。 */
  readonly count: number;
  /** 严格排在 key 之前的作业耗时和。 */
  readonly sum: number;
}

/** 比较两个键：返回负数表示 a 排在 b 前。 */
export function compareKeys(a: TreapKey, b: TreapKey): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.seq - b.seq;
}

export function createNode(key: TreapKey, duration: number, heap: number): TreapNode {
  return { key, duration, heap, left: null, right: null, size: 1, sum: duration };
}

function pull(node: TreapNode): void {
  let size = 1;
  let sum = node.duration;
  if (node.left !== null) {
    size += node.left.size;
    sum += node.left.sum;
  }
  if (node.right !== null) {
    size += node.right.size;
    sum += node.right.sum;
  }
  node.size = size;
  node.sum = sum;
}

function rotateRight(node: TreapNode): TreapNode {
  const child = node.left as TreapNode;
  node.left = child.right;
  child.right = node;
  pull(node);
  pull(child);
  return child;
}

function rotateLeft(node: TreapNode): TreapNode {
  const child = node.right as TreapNode;
  node.right = child.left;
  child.left = node;
  pull(node);
  pull(child);
  return child;
}

/** 插入节点（键不得已存在），返回新根。 */
export function insertNode(root: TreapNode | null, node: TreapNode): TreapNode {
  if (root === null) return node;
  if (compareKeys(node.key, root.key) < 0) {
    root.left = insertNode(root.left, node);
    pull(root);
    if (root.left !== null && root.left.heap < root.heap) {
      return rotateRight(root);
    }
    return root;
  }
  root.right = insertNode(root.right, node);
  pull(root);
  if (root.right !== null && root.right.heap < root.heap) {
    return rotateLeft(root);
  }
  return root;
}

/** 合并两棵树：left 中所有键都小于 right 中的键。 */
function mergeTrees(left: TreapNode | null, right: TreapNode | null): TreapNode | null {
  if (left === null) return right;
  if (right === null) return left;
  if (left.heap < right.heap) {
    left.right = mergeTrees(left.right, right);
    pull(left);
    return left;
  }
  right.left = mergeTrees(left, right.left);
  pull(right);
  return right;
}

/** 删除指定键的节点，返回新根。 */
export function eraseNode(root: TreapNode | null, key: TreapKey): TreapNode | null {
  if (root === null) return null;
  const cmp = compareKeys(key, root.key);
  if (cmp < 0) {
    root.left = eraseNode(root.left, key);
    pull(root);
    return root;
  }
  if (cmp > 0) {
    root.right = eraseNode(root.right, key);
    pull(root);
    return root;
  }
  return mergeTrees(root.left, root.right);
}

/** 统计严格排在 key 之前的作业数量与耗时和。 */
export function prefixStat(root: TreapNode | null, key: TreapKey): PrefixStat {
  let count = 0;
  let sum = 0;
  let node = root;
  while (node !== null) {
    if (compareKeys(key, node.key) <= 0) {
      node = node.left;
    } else {
      count += (node.left === null ? 0 : node.left.size) + 1;
      sum += (node.left === null ? 0 : node.left.sum) + node.duration;
      node = node.right;
    }
  }
  return { count, sum };
}
