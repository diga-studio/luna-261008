/**
 * 可删除的极值多重集合。
 * add/remove/top 均摊 O(log n)：堆内懒删除，计数表记录每个值的剩余份数。
 * 用于 minPinLength（取最大）与 maxAutoLockSeconds（取最小）。
 */
export class ExtremumMultiset {
  private readonly counts = new Map<number, number>();
  private readonly heap: number[] = [];
  /** sign = +1 时堆顶为最小值，-1 时为最大值。 */
  private readonly sign: 1 | -1;
  private live = 0;

  private constructor(sign: 1 | -1) {
    this.sign = sign;
  }

  static max(): ExtremumMultiset {
    return new ExtremumMultiset(-1);
  }

  static min(): ExtremumMultiset {
    return new ExtremumMultiset(1);
  }

  get size(): number {
    return this.live;
  }

  add(value: number): void {
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
    this.heap.push(value);
    this.siftUp(this.heap.length - 1);
    this.live += 1;
  }

  remove(value: number): void {
    const remaining = (this.counts.get(value) ?? 0) - 1;
    if (remaining < 0) {
      throw new Error('ExtremumMultiset: remove of absent value');
    }
    if (remaining === 0) {
      this.counts.delete(value);
    } else {
      this.counts.set(value, remaining);
    }
    this.live -= 1;
  }

  /** 当前极值；空集合返回 undefined。 */
  top(): number | undefined {
    while (this.heap.length > 0) {
      const candidate = this.heap[0] as number;
      if ((this.counts.get(candidate) ?? 0) > 0) {
        return candidate;
      }
      this.popHeap();
    }
    return undefined;
  }

  private higher(a: number, b: number): boolean {
    return (a - b) * this.sign < 0;
  }

  private siftUp(index: number): void {
    const heap = this.heap;
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.higher(heap[i] as number, heap[parent] as number)) break;
      const tmp = heap[i] as number;
      heap[i] = heap[parent] as number;
      heap[parent] = tmp;
      i = parent;
    }
  }

  private popHeap(): void {
    const heap = this.heap;
    const last = heap.pop() as number;
    if (heap.length === 0) return;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < heap.length && this.higher(heap[left] as number, heap[best] as number)) best = left;
      if (right < heap.length && this.higher(heap[right] as number, heap[best] as number)) best = right;
      if (best === i) break;
      const tmp = heap[i] as number;
      heap[i] = heap[best] as number;
      heap[best] = tmp;
      i = best;
    }
  }
}
