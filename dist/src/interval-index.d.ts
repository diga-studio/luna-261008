export declare class IntervalIndex {
    private root;
    private count;
    get size(): number;
    insert(sessionId: string, start: number, end: number): void;
    private insertNode;
    /** 删除指定区间。调用方必须提供该场次当前记录中的 start（键的一部分）。 */
    remove(sessionId: string, start: number): void;
    private removeNode;
    /**
     * 对所有与 [start, end) 重叠（左闭右开，首尾相接不算重叠）的区间调用 visit。
     * skip 中的 sessionId 被忽略（用于排除批次内场次的旧区间）。
     */
    forEachOverlap(start: number, end: number, skip: ReadonlySet<string> | null, visit: (sessionId: string, start: number, end: number) => void): void;
    private query;
}
