/**
 * 一段字幕的输入数据。
 * 时间均为整数毫秒，weight 取值 1..9。
 */
export interface SegmentInput {
    /** 原开始时刻（毫秒，>= 0） */
    readonly start: number;
    /** 原结束时刻（毫秒，<= 视频总时长） */
    readonly end: number;
    /** 最低展示时长（毫秒，>= 0） */
    readonly minDuration: number;
    /** 同步重要性权重（1..9） */
    readonly weight: number;
    /** 锁定标记：锁定段的开始与结束必须原样保留 */
    readonly locked: boolean;
}
/** 调整后的单段时间轴 */
export interface AdjustedSegment {
    readonly start: number;
    readonly end: number;
}
/** 校时成功结果 */
export interface AlignOk {
    readonly ok: true;
    /** 与输入一一对应的调整后时间轴 */
    readonly segments: readonly AdjustedSegment[];
    /** 全轨总偏移成本（精确值，可能超过 Number 安全整数范围，故用 bigint） */
    readonly totalCost: bigint;
}
/** 无解结果：约束无法同时满足 */
export interface AlignInfeasible {
    readonly ok: false;
}
export declare type AlignResult = AlignOk | AlignInfeasible;
