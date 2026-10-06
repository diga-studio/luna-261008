/**
 * Weighted interval map over the millisecond timeline.
 *
 * Maintains a partition of (-Infinity, +Infinity) into half-open runs
 * [start, end), each carrying an integer weight. Supports range-add and
 * reporting of all maximal runs whose weight is strictly positive,
 * clipped to a query range.
 *
 * Implemented as a randomized treap keyed by run start with lazy
 * propagation and subtree min/max augmentation, so that queries only
 * descend into parts of the timeline that can contain positive values.
 * Nodes live in columnar typed arrays (structure-of-arrays) to keep the
 * memory footprint flat for millions of runs; index 0 means "null".
 */

const NULL = 0;

export class WeightedIntervalMap {
  private start = new Float64Array(64);
  private end = new Float64Array(64);
  private val = new Int32Array(64);
  private lazy = new Int32Array(64);
  private min = new Int32Array(64);
  private max = new Int32Array(64);
  private minStart = new Float64Array(64);
  private maxEnd = new Float64Array(64);
  private prio = new Uint32Array(64);
  private left = new Int32Array(64);
  private right = new Int32Array(64);
  private nodes = 1; // next free slot; slot 0 is the null sentinel
  private root = NULL;

  constructor() {
    // The initial run covers the whole timeline with weight 0.
    this.root = this.makeNode(-Infinity, Infinity, 0);
  }

  /** Number of runs in the partition (diagnostics). */
  get size(): number {
    return this.nodes - 1;
  }

  /** splitmix32: deterministic pseudo-random priority for a node id. */
  private static hash(id: number): number {
    let z = (id + 0x9e3779b9) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  }

  private makeNode(start: number, end: number, val: number): number {
    if (this.nodes === this.start.length) this.grow();
    const id = this.nodes;
    this.nodes += 1;
    this.start[id] = start;
    this.end[id] = end;
    this.val[id] = val;
    this.lazy[id] = 0;
    this.min[id] = val;
    this.max[id] = val;
    this.minStart[id] = start;
    this.maxEnd[id] = end;
    this.prio[id] = WeightedIntervalMap.hash(id);
    this.left[id] = NULL;
    this.right[id] = NULL;
    return id;
  }

  private grow(): void {
    const capacity = this.start.length * 2;
    const f64 = (array: Float64Array): Float64Array => {
      const next = new Float64Array(capacity);
      next.set(array);
      return next;
    };
    const i32 = (array: Int32Array): Int32Array => {
      const next = new Int32Array(capacity);
      next.set(array);
      return next;
    };
    const u32 = (array: Uint32Array): Uint32Array => {
      const next = new Uint32Array(capacity);
      next.set(array);
      return next;
    };
    this.start = f64(this.start);
    this.end = f64(this.end);
    this.val = i32(this.val);
    this.lazy = i32(this.lazy);
    this.min = i32(this.min);
    this.max = i32(this.max);
    this.minStart = f64(this.minStart);
    this.maxEnd = f64(this.maxEnd);
    this.prio = u32(this.prio);
    this.left = i32(this.left);
    this.right = i32(this.right);
  }

  private pull(node: number): void {
    let min = this.val[node] as number;
    let max = this.val[node] as number;
    let minStart = this.start[node] as number;
    let maxEnd = this.end[node] as number;
    const left = this.left[node] as number;
    if (left !== NULL) {
      if ((this.min[left] as number) < min) min = this.min[left] as number;
      if ((this.max[left] as number) > max) max = this.max[left] as number;
      if ((this.minStart[left] as number) < minStart) minStart = this.minStart[left] as number;
      if ((this.maxEnd[left] as number) > maxEnd) maxEnd = this.maxEnd[left] as number;
    }
    const right = this.right[node] as number;
    if (right !== NULL) {
      if ((this.min[right] as number) < min) min = this.min[right] as number;
      if ((this.max[right] as number) > max) max = this.max[right] as number;
      if ((this.minStart[right] as number) < minStart) minStart = this.minStart[right] as number;
      if ((this.maxEnd[right] as number) > maxEnd) maxEnd = this.maxEnd[right] as number;
    }
    this.min[node] = min;
    this.max[node] = max;
    this.minStart[node] = minStart;
    this.maxEnd[node] = maxEnd;
  }

  private applyAdd(node: number, delta: number): void {
    this.val[node] = (this.val[node] as number) + delta;
    this.min[node] = (this.min[node] as number) + delta;
    this.max[node] = (this.max[node] as number) + delta;
    this.lazy[node] = (this.lazy[node] as number) + delta;
  }

  private push(node: number): void {
    const delta = this.lazy[node] as number;
    if (delta !== 0) {
      const left = this.left[node] as number;
      if (left !== NULL) this.applyAdd(left, delta);
      const right = this.right[node] as number;
      if (right !== NULL) this.applyAdd(right, delta);
      this.lazy[node] = 0;
    }
  }

  /** Splits into [keys < key, keys >= key]. */
  private split(node: number, key: number): [number, number] {
    if (node === NULL) return [NULL, NULL];
    this.push(node);
    if ((this.start[node] as number) < key) {
      const [l, r] = this.split(this.right[node] as number, key);
      this.right[node] = l;
      this.pull(node);
      return [node, r];
    }
    const [l, r] = this.split(this.left[node] as number, key);
    this.left[node] = r;
    this.pull(node);
    return [l, node];
  }

  private merge(a: number, b: number): number {
    if (a === NULL) return b;
    if (b === NULL) return a;
    if ((this.prio[a] as number) < (this.prio[b] as number)) {
      this.push(a);
      this.right[a] = this.merge(this.right[a] as number, b);
      this.pull(a);
      return a;
    }
    this.push(b);
    this.left[b] = this.merge(a, this.left[b] as number);
    this.pull(b);
    return b;
  }

  /** Splits off the node with the maximum key: returns [rest, maxNode]. */
  private splitMax(node: number): [number, number] {
    this.push(node);
    const right = this.right[node] as number;
    if (right === NULL) {
      const rest = this.left[node] as number;
      this.left[node] = NULL;
      this.pull(node);
      return [rest, node];
    }
    const [newRight, maxNode] = this.splitMax(right);
    this.right[node] = newRight;
    this.pull(node);
    return [node, maxNode];
  }

  /** Ensures a run boundary exists exactly at `key`. */
  private ensureBoundary(key: number): void {
    const [a, bc] = this.split(this.root, key);
    if (bc !== NULL && (this.minStart[bc] as number) === key) {
      this.root = this.merge(a, bc);
      return;
    }
    // The run containing `key` is the rightmost run of `a`; it spans
    // [s, e) with s < key < e because runs partition the whole timeline.
    if (a === NULL) throw new Error("unreachable: missing leftmost run");
    const [rest, prev] = this.splitMax(a);
    const next = this.makeNode(key, this.end[prev] as number, this.val[prev] as number);
    this.end[prev] = key;
    this.pull(prev);
    this.root = this.merge(this.merge(rest, prev), this.merge(next, bc));
  }

  /** Adds `delta` to the weight of every point in [startMs, endMs). */
  addRange(startMs: number, endMs: number, delta: number): void {
    if (delta === 0 || startMs >= endMs) return;
    this.ensureBoundary(startMs);
    this.ensureBoundary(endMs);
    const [a, bc] = this.split(this.root, startMs);
    const [b, c] = this.split(bc, endMs);
    if (b !== NULL) this.applyAdd(b, delta);
    this.root = this.merge(a, this.merge(b, c));
  }

  /**
   * Returns all maximal half-open intervals inside [startMs, endMs)
   * whose weight is strictly positive, merged and clipped to the range.
   */
  positiveIntervals(startMs: number, endMs: number): Array<{ startMs: number; endMs: number }> {
    const out: Array<{ startMs: number; endMs: number }> = [];
    if (startMs >= endMs) return out;
    this.collect(this.root, startMs, endMs, out);
    return out;
  }

  private collect(
    node: number,
    startMs: number,
    endMs: number,
    out: Array<{ startMs: number; endMs: number }>,
  ): void {
    if (node === NULL) return;
    if ((this.max[node] as number) <= 0) return; // entirely non-positive
    if ((this.maxEnd[node] as number) <= startMs || (this.minStart[node] as number) >= endMs) {
      return; // outside range
    }
    this.push(node);
    if ((this.min[node] as number) > 0) {
      // Entire subtree is positive and its runs are contiguous.
      WeightedIntervalMap.emit(
        out,
        Math.max(this.minStart[node] as number, startMs),
        Math.min(this.maxEnd[node] as number, endMs),
      );
      return;
    }
    this.collect(this.left[node] as number, startMs, endMs, out);
    if ((this.val[node] as number) > 0) {
      WeightedIntervalMap.emit(
        out,
        Math.max(this.start[node] as number, startMs),
        Math.min(this.end[node] as number, endMs),
      );
    }
    this.collect(this.right[node] as number, startMs, endMs, out);
  }

  private static emit(
    out: Array<{ startMs: number; endMs: number }>,
    startMs: number,
    endMs: number,
  ): void {
    if (startMs >= endMs) return;
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last !== undefined && startMs <= last.endMs) {
      if (endMs > last.endMs) last.endMs = endMs;
      return;
    }
    out.push({ startMs, endMs });
  }
}
