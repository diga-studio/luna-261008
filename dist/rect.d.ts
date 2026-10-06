/**
 * 连接空间中的轴对齐矩形：源地址、目的地址、目的端口三个维度。
 * ICMP 的端口维度退化为单点 [0,0]，表示“无端口”。
 */
export interface Rect {
    readonly srcMin: bigint;
    readonly srcMax: bigint;
    readonly dstMin: bigint;
    readonly dstMax: bigint;
    readonly portMin: number;
    readonly portMax: number;
}
/** 从 rects 中减去 block，返回剩余矩形列表（精确、不重叠）。 */
export declare function subtractRect(rects: readonly Rect[], block: Rect): Rect[];
