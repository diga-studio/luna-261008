/**
 * 可删除的极值多重集合。
 * add/remove/top 均摊 O(log n)：堆内懒删除，计数表记录每个值的剩余份数。
 * 用于 minPinLength（取最大）与 maxAutoLockSeconds（取最小）。
 */
export declare class ExtremumMultiset {
    private readonly counts;
    private readonly heap;
    /** sign = +1 时堆顶为最小值，-1 时为最大值。 */
    private readonly sign;
    private live;
    private constructor();
    static max(): ExtremumMultiset;
    static min(): ExtremumMultiset;
    get size(): number;
    add(value: number): void;
    remove(value: number): void;
    /** 当前极值；空集合返回 undefined。 */
    top(): number | undefined;
    private higher;
    private siftUp;
    private popHeap;
}
