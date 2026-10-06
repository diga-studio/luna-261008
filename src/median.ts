/**
 * Mutable multiset of (value, weight) points that tracks the lower weighted
 * median: the smallest point value v such that the cumulative weight of all
 * points <= v reaches half of the total weight.
 *
 * Implemented with a max-heap `lo` and a min-heap `hi` maintaining:
 *   - every value in `lo` <= every value in `hi`
 *   - wLo * 2 >= total            (enough weight at/below the median)
 *   - (wLo - topWeight(lo)) * 2 < total   (strictly less weight below it)
 * Under these invariants max(lo) is exactly the lower weighted median.
 */
export class MedianBag {
  private loV: number[] = [];
  private loW: number[] = [];
  private hiV: number[] = [];
  private hiW: number[] = [];
  private wLo = 0;
  private wHi = 0;

  get size(): number {
    return this.loV.length + this.hiV.length;
  }

  get median(): number {
    return this.loV[0];
  }

  add(value: number, weight: number): void {
    if (this.loV.length === 0 || value <= this.loV[0]) {
      this.pushLo(value, weight);
    } else {
      this.pushHi(value, weight);
    }
    this.rebalance();
  }

  /** Merge all points of `other` into this bag; `other` is left empty. */
  absorb(other: MedianBag): void {
    if (other.size > this.size) {
      this.swapWith(other);
    }
    for (let i = 0; i < other.loV.length; i++) this.add(other.loV[i], other.loW[i]);
    for (let i = 0; i < other.hiV.length; i++) this.add(other.hiV[i], other.hiW[i]);
    other.loV = [];
    other.loW = [];
    other.hiV = [];
    other.hiW = [];
    other.wLo = 0;
    other.wHi = 0;
  }

  private swapWith(other: MedianBag): void {
    [this.loV, other.loV] = [other.loV, this.loV];
    [this.loW, other.loW] = [other.loW, this.loW];
    [this.hiV, other.hiV] = [other.hiV, this.hiV];
    [this.hiW, other.hiW] = [other.hiW, this.hiW];
    [this.wLo, other.wLo] = [other.wLo, this.wLo];
    [this.wHi, other.wHi] = [other.wHi, this.wHi];
  }

  private rebalance(): void {
    const total = this.wLo + this.wHi;
    while (this.wLo * 2 < total) {
      const [v, w] = this.popHi();
      this.pushLo(v, w);
    }
    while ((this.wLo - this.loW[0]) * 2 >= total) {
      const [v, w] = this.popLo();
      this.pushHi(v, w);
    }
  }

  private pushLo(v: number, w: number): void {
    this.wLo += w;
    siftUp(this.loV, this.loW, v, w, (a, b) => a > b);
  }

  private popLo(): [number, number] {
    const root = siftDownRoot(this.loV, this.loW, (a, b) => a > b);
    this.wLo -= root[1];
    return root;
  }

  private pushHi(v: number, w: number): void {
    this.wHi += w;
    siftUp(this.hiV, this.hiW, v, w, (a, b) => a < b);
  }

  private popHi(): [number, number] {
    const root = siftDownRoot(this.hiV, this.hiW, (a, b) => a < b);
    this.wHi -= root[1];
    return root;
  }
}

function siftUp(
  values: number[],
  weights: number[],
  v: number,
  w: number,
  better: (a: number, b: number) => boolean,
): void {
  values.push(v);
  weights.push(w);
  let i = values.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!better(values[i], values[parent])) break;
    [values[i], values[parent]] = [values[parent], values[i]];
    [weights[i], weights[parent]] = [weights[parent], weights[i]];
    i = parent;
  }
}

function siftDownRoot(
  values: number[],
  weights: number[],
  better: (a: number, b: number) => boolean,
): [number, number] {
  const rootV = values[0];
  const rootW = weights[0];
  const lastV = values.pop() as number;
  const lastW = weights.pop() as number;
  if (values.length > 0) {
    values[0] = lastV;
    weights[0] = lastW;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let best = i;
      if (l < values.length && better(values[l], values[best])) best = l;
      if (r < values.length && better(values[r], values[best])) best = r;
      if (best === i) break;
      [values[i], values[best]] = [values[best], values[i]];
      [weights[i], weights[best]] = [weights[best], weights[i]];
      i = best;
    }
  }
  return [rootV, rootW];
}
