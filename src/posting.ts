import { Bitset } from './bitset';

/** Lists larger than this are promoted to a dense bitset representation. */
const DENSE_THRESHOLD = 2048;

/**
 * Posting list of user indexes for one indexed value (a region or a tag).
 *
 * Sparse lists are kept as a sorted number array (binary-search insert and
 * remove, cheap for small lists). Once a list grows past DENSE_THRESHOLD it
 * is promoted to a bitset, so values shared by most profiles (e.g. a tag on
 * 90% of profiles) keep O(1) updates and O(words) snapshots. Memory stays
 * bounded because the number of dense lists is limited by the total number
 * of (profile, value) pairs divided by the threshold.
 */
export class PostingList {
  private arr: number[] = [];
  private bits: Bitset | null = null;
  private count = 0;

  add(index: number): void {
    if (this.bits) {
      if (this.bits.get(index) === 1) return;
      this.bits.set(index);
      this.count++;
      return;
    }
    const pos = lowerBound(this.arr, index);
    if (pos < this.arr.length && this.arr[pos] === index) return;
    this.arr.splice(pos, 0, index);
    this.count++;
    if (this.arr.length > DENSE_THRESHOLD) {
      const bits = new Bitset(index + 1);
      for (const value of this.arr) bits.set(value);
      this.bits = bits;
      this.arr = [];
    }
  }

  remove(index: number): void {
    if (this.bits) {
      this.bits.clear(index);
      this.count--;
      return;
    }
    const pos = lowerBound(this.arr, index);
    if (pos < this.arr.length && this.arr[pos] === index) {
      this.arr.splice(pos, 1);
      this.count--;
    }
  }

  /** ORs this list into the target bitset without allocating. */
  orInto(target: Bitset): void {
    if (this.bits) {
      target.orWith(this.bits);
      return;
    }
    for (const value of this.arr) target.set(value);
  }

  get size(): number {
    return this.count;
  }
}

function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
