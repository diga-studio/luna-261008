"use strict";
/**
 * 加权 L1 保序回归（内部使用）。
 *
 * 求解：minimize  sum_j w[j] * |y[j] - b[j]|
 *       subject to y[0] <= y[1] <= ... <= y[n-1]
 *
 * 返回所有最优解中逐分量最小（从而字典序最小）的那个。
 *
 * 算法：PAVA（Pool Adjacent Violators）。每个块维护“下加权中位数”
 * （使累积权重大于等于总权重一半的最小值），当相邻两块的下加权中位数
 * 左大于右时合并。块内用两个堆（左大根堆、右小根堆）维护加权中位数，
 * 合并时小堆并入大堆，总复杂度 O(n log^2 n)。
 *
 * 为让堆中元素互不相同（简化中位数不变式），键值使用
 * key = (value - minValue) * n + index 做平移放大，比较时天然带下标次序；
 * 还原时取 Math.floor(key / n) + minValue。数值范围远小于 2^53，精确安全。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isotonicL1Min = void 0;
/** 大根堆 / 小根堆的通用操作（数组就地实现） */
function heapPush(heap, key, isMax) {
    heap.push(key);
    let i = heap.length - 1;
    while (i > 0) {
        const parent = (i - 1) >> 1;
        const better = isMax ? heap[i] > heap[parent] : heap[i] < heap[parent];
        if (!better)
            break;
        const tmp = heap[parent];
        heap[parent] = heap[i];
        heap[i] = tmp;
        i = parent;
    }
}
function heapPop(heap, isMax) {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
            const left = i * 2 + 1;
            const right = left + 1;
            let best = i;
            if (left < heap.length) {
                const better = isMax ? heap[left] > heap[best] : heap[left] < heap[best];
                if (better)
                    best = left;
            }
            if (right < heap.length) {
                const better = isMax ? heap[right] > heap[best] : heap[right] < heap[best];
                if (better)
                    best = right;
            }
            if (best === i)
                break;
            const tmp = heap[best];
            heap[best] = heap[i];
            heap[i] = tmp;
            i = best;
        }
    }
    return top;
}
/** 一个 PAVA 块：维护元素的双堆结构以求下加权中位数 */
class Block {
    constructor(start) {
        /** 大根堆：存放键值较小的一半 */
        this.maxHeap = [];
        /** 小根堆：存放键值较大的一半 */
        this.minHeap = [];
        /** maxHeap 中元素的权重和 */
        this.weightLeft = 0;
        /** 块内元素总权重 */
        this.weightTotal = 0;
        this.start = start;
        this.end = start + 1;
    }
    /** 向块中加入一个键值（调用方保证 weightTotal 已更新），随后恢复中位数不变式 */
    addKey(key, weight) {
        if (this.maxHeap.length === 0 || key <= this.maxHeap[0]) {
            heapPush(this.maxHeap, key, true);
            this.weightLeft += weight;
        }
        else {
            heapPush(this.minHeap, key, false);
        }
    }
    /** 恢复不变式：weightLeft >= W/2 且 weightLeft - w(堆顶) < W/2 */
    rebalance(weights, scale) {
        const half = this.weightTotal / 2;
        while (this.weightLeft < half) {
            const key = heapPop(this.minHeap, false);
            heapPush(this.maxHeap, key, true);
            this.weightLeft += weights[key % scale];
        }
        for (;;) {
            const topWeight = weights[this.maxHeap[0] % scale];
            if (this.weightLeft - topWeight < half)
                break;
            const key = heapPop(this.maxHeap, true);
            this.weightLeft -= topWeight;
            heapPush(this.minHeap, key, false);
        }
    }
    /** 下加权中位数对应的原始值 */
    lowerMedian(minValue, scale) {
        return Math.floor(this.maxHeap[0] / scale) + minValue;
    }
}
function isotonicL1Min(b, w) {
    const n = b.length;
    if (n === 0)
        return [];
    let minValue = b[0];
    for (let j = 1; j < n; j++) {
        if (b[j] < minValue)
            minValue = b[j];
    }
    const scale = n; // 下标 j < n，故 key = (b - minValue) * n + j 互不相同
    const keyOf = (j) => (b[j] - minValue) * scale + j;
    const blocks = [];
    for (let j = 0; j < n; j++) {
        const block = new Block(j);
        block.weightTotal = w[j];
        block.addKey(keyOf(j), w[j]);
        block.rebalance(w, scale);
        blocks.push(block);
        // 合并违反单调性的相邻块（左块下加权中位数 > 右块）
        while (blocks.length >= 2) {
            const right = blocks[blocks.length - 1];
            const left = blocks[blocks.length - 2];
            if (left.lowerMedian(minValue, scale) <= right.lowerMedian(minValue, scale)) {
                break;
            }
            // 小堆并入大堆，保持均摊复杂度
            let base = left;
            let other = right;
            if (right.maxHeap.length + right.minHeap.length > left.maxHeap.length + left.minHeap.length) {
                base = right;
                other = left;
            }
            for (const key of other.maxHeap) {
                base.weightTotal += w[key % scale];
                base.addKey(key, w[key % scale]);
            }
            for (const key of other.minHeap) {
                base.weightTotal += w[key % scale];
                base.addKey(key, w[key % scale]);
            }
            base.start = left.start;
            base.end = right.end;
            base.rebalance(w, scale);
            blocks.splice(blocks.length - 2, 2, base);
        }
    }
    const result = new Array(n);
    for (const block of blocks) {
        const value = block.lowerMedian(minValue, scale);
        for (let j = block.start; j < block.end; j++) {
            result[j] = value;
        }
    }
    return result;
}
exports.isotonicL1Min = isotonicL1Min;
