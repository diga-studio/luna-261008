/**
 * 每台印机一个 treap：BST 键为 (优先级, 入队序号)，堆键为随机数。
 * 子树维护 size 与耗时和，支持 O(log n) 的插入、删除、排名与前缀耗时查询。
 */

export interface TreapNode {
  /** 作业标识（调用方用于映射） */
  jobId: string;
  /** 业务优先级 1-5 */
  prio: number;
  /** 入队序号（全局递增，改派时重新分配） */
  seq: number;
  /** 单作业耗时（秒，已向上取整） */
  duration: number;
  /** 堆优先级（随机） */
  heap: number;
  left: TreapNode | null;
  right: TreapNode | null;
  parent: TreapNode | null;
  size: number;
  sum: number;
}

let rngState = 0x9e3779b9;

function nextRandom(): number {
  // xorshift32，避免 Math.random 的开销与不可控性
  let x = rngState;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  rngState = x >>> 0;
  return rngState;
}

function sizeOf(n: TreapNode | null): number {
  return n === null ? 0 : n.size;
}

function sumOf(n: TreapNode | null): number {
  return n === null ? 0 : n.sum;
}

function pull(n: TreapNode): void {
  n.size = 1 + sizeOf(n.left) + sizeOf(n.right);
  n.sum = n.duration + sumOf(n.left) + sumOf(n.right);
}

/** 键比较：优先级小者靠前，同级按入队序号 */
function keyLess(prioA: number, seqA: number, prioB: number, seqB: number): boolean {
  return prioA < prioB || (prioA === prioB && seqA < seqB);
}

export function makeNode(
  jobId: string,
  prio: number,
  seq: number,
  duration: number,
): TreapNode {
  return {
    jobId,
    prio,
    seq,
    duration,
    heap: nextRandom(),
    left: null,
    right: null,
    parent: null,
    size: 1,
    sum: duration,
  };
}

/** 按 (prio, seq) 切分：left 为严格小于该键的部分 */
function split(
  root: TreapNode | null,
  prio: number,
  seq: number,
): [TreapNode | null, TreapNode | null] {
  if (root === null) {
    return [null, null];
  }
  if (keyLess(root.prio, root.seq, prio, seq)) {
    const pair = split(root.right, prio, seq);
    root.right = pair[0];
    if (pair[0] !== null) pair[0].parent = root;
    pull(root);
    root.parent = null;
    if (pair[1] !== null) pair[1].parent = null;
    return [root, pair[1]];
  }
  const pair = split(root.left, prio, seq);
  root.left = pair[1];
  if (pair[1] !== null) pair[1].parent = root;
  pull(root);
  root.parent = null;
  if (pair[0] !== null) pair[0].parent = null;
  return [pair[0], root];
}

/** 合并两棵树，要求 a 中所有键都小于 b 中所有键 */
function merge(a: TreapNode | null, b: TreapNode | null): TreapNode | null {
  if (a === null) {
    if (b !== null) b.parent = null;
    return b;
  }
  if (b === null) {
    a.parent = null;
    return a;
  }
  if (a.heap < b.heap) {
    const r = merge(a.right, b);
    a.right = r;
    if (r !== null) r.parent = a;
    pull(a);
    a.parent = null;
    return a;
  }
  const l = merge(a, b.left);
  b.left = l;
  if (l !== null) l.parent = b;
  pull(b);
  b.parent = null;
  return b;
}

/** 将节点按 (prio, seq) 插入以 root 为根的 treap，返回新根 */
export function insert(root: TreapNode | null, node: TreapNode): TreapNode {
  node.left = null;
  node.right = null;
  node.parent = null;
  node.size = 1;
  node.sum = node.duration;
  const pair = split(root, node.prio, node.seq);
  const left = merge(pair[0], node);
  const merged = merge(left, pair[1]);
  // merge 仅在两端均空时返回 null，此处 node 非空，故结果必非空
  return merged as TreapNode;
}

/** 从 treap 中删除节点，返回新根 */
export function erase(root: TreapNode | null, node: TreapNode): TreapNode | null {
  const merged = merge(node.left, node.right);
  const parent = node.parent;
  if (merged !== null) {
    merged.parent = parent;
  }
  if (parent === null) {
    root = merged;
  } else if (parent.left === node) {
    parent.left = merged;
  } else {
    parent.right = merged;
  }
  node.left = null;
  node.right = null;
  node.parent = null;
  node.size = 1;
  node.sum = node.duration;
  let cursor = parent;
  while (cursor !== null) {
    pull(cursor);
    cursor = cursor.parent;
  }
  return root;
}

/** 节点在树中的排名（0 起，即严格排在其前面的节点数） */
export function rankOf(node: TreapNode): number {
  let rank = sizeOf(node.left);
  let cursor: TreapNode = node;
  while (cursor.parent !== null) {
    const parent: TreapNode = cursor.parent;
    if (parent.right === cursor) {
      rank += sizeOf(parent.left) + 1;
    }
    cursor = parent;
  }
  return rank;
}

/** 严格排在该节点之前的所有节点耗时之和 */
export function prefixSumOf(node: TreapNode): number {
  let sum = sumOf(node.left);
  let cursor: TreapNode = node;
  while (cursor.parent !== null) {
    const parent: TreapNode = cursor.parent;
    if (parent.right === cursor) {
      sum += sumOf(parent.left) + parent.duration;
    }
    cursor = parent;
  }
  return sum;
}
