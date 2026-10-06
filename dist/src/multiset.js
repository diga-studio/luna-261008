"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtremumMultiset = void 0;
/**
 * 可删除的极值多重集合。
 * add/remove/top 均摊 O(log n)：堆内懒删除，计数表记录每个值的剩余份数。
 * 用于 minPinLength（取最大）与 maxAutoLockSeconds（取最小）。
 */
class ExtremumMultiset {
    counts = new Map();
    heap = [];
    /** sign = +1 时堆顶为最小值，-1 时为最大值。 */
    sign;
    live = 0;
    constructor(sign) {
        this.sign = sign;
    }
    static max() {
        return new ExtremumMultiset(-1);
    }
    static min() {
        return new ExtremumMultiset(1);
    }
    get size() {
        return this.live;
    }
    add(value) {
        this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
        this.heap.push(value);
        this.siftUp(this.heap.length - 1);
        this.live += 1;
    }
    remove(value) {
        const remaining = (this.counts.get(value) ?? 0) - 1;
        if (remaining < 0) {
            throw new Error('ExtremumMultiset: remove of absent value');
        }
        if (remaining === 0) {
            this.counts.delete(value);
        }
        else {
            this.counts.set(value, remaining);
        }
        this.live -= 1;
    }
    /** 当前极值；空集合返回 undefined。 */
    top() {
        while (this.heap.length > 0) {
            const candidate = this.heap[0];
            if ((this.counts.get(candidate) ?? 0) > 0) {
                return candidate;
            }
            this.popHeap();
        }
        return undefined;
    }
    higher(a, b) {
        return (a - b) * this.sign < 0;
    }
    siftUp(index) {
        const heap = this.heap;
        let i = index;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this.higher(heap[i], heap[parent]))
                break;
            const tmp = heap[i];
            heap[i] = heap[parent];
            heap[parent] = tmp;
            i = parent;
        }
    }
    popHeap() {
        const heap = this.heap;
        const last = heap.pop();
        if (heap.length === 0)
            return;
        heap[0] = last;
        let i = 0;
        for (;;) {
            const left = i * 2 + 1;
            const right = left + 1;
            let best = i;
            if (left < heap.length && this.higher(heap[left], heap[best]))
                best = left;
            if (right < heap.length && this.higher(heap[right], heap[best]))
                best = right;
            if (best === i)
                break;
            const tmp = heap[i];
            heap[i] = heap[best];
            heap[best] = tmp;
            i = best;
        }
    }
}
exports.ExtremumMultiset = ExtremumMultiset;
