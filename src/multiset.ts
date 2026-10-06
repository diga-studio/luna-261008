/**
 * 支持删除的数值多重集合，可查询当前最大/最小值。
 * 用于 minPinLength（取最大）与 maxAutoLockSeconds（取最小）的增量聚合。
 *
 * 实现：二叉堆 + 存活计数表。删除只在计数表中标记，
 * 堆顶查询时惰性弹出已失效元素。add/remove/top 均为摊还 O(log n)。
 */
export class ExtremumMultiset {
  private readonly counts = new Map<number, number>();
  private readonly heap: number[] = [];
  private liveSize = 0;

  constructor(private readonly mode: 'max' | 'min') {}

  /** 当前存活元素个数。 */
  get size(): number {
    return this.liveSize;
  }

  add(value: number): void {
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
    this.liveSize += 1;
    this.heapPush(value);
  }

  /** 删除一个先前加入的元素；调用方保证该元素当前存活。 */
  remove(value: number): void {
    const remaining = (this.counts.get(value) ?? 0) - 1;
    if (remaining <= 0) {
      this.counts.delete(value);
    } else {
      this.counts.set(value, remaining);
    }
    this.liveSize -= 1;
  }

  /** 当前极值（max 模式为最大值，min 模式为最小值）；空集合返回 undefined。 */
  top(): number | undefined {
    const heap = this.heap;
    while (heap.length > 0) {
      const top = heap[0] as number;
      if (this.counts.has(top)) {
        return top;
      }
      this.heapPop();
    }
    return undefined;
  }

  private better(a: number, b: number): boolean {
    return this.mode === 'max' ? a > b : a < b;
  }

  private heapPush(value: number): void {
    const heap = this.heap;
    heap.push(value);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.better(heap[i] as number, heap[parent] as number)) break;
      const tmp = heap[i] as number;
      heap[i] = heap[parent] as number;
      heap[parent] = tmp;
      i = parent;
    }
  }

  private heapPop(): void {
    const heap = this.heap;
    const last = heap.pop() as number;
    if (heap.length === 0) return;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < heap.length && this.better(heap[left] as number, heap[best] as number)) best = left;
      if (right < heap.length && this.better(heap[right] as number, heap[best] as number)) best = right;
      if (best === i) break;
      const tmp = heap[i] as number;
      heap[i] = heap[best] as number;
      heap[best] = tmp;
      i = best;
    }
  }
}
