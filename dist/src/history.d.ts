import type { ChangeRecord, TimeWindow, Token } from "./types.js";
/** 同一身份同一毫秒取最大 seq，结果按 effectiveAt 升序 */
export declare function buildTimeline(changes: readonly ChangeRecord[]): ChangeRecord[];
/** 时刻 t 生效的变更；首次变更之前返回 undefined */
export declare function changeAt(timeline: readonly ChangeRecord[], t: number): ChangeRecord | undefined;
/** 单时刻准入：active + 有准入权限 + 所属单位不在黑名单 */
export declare function canEnterAt(timeline: readonly ChangeRecord[], t: number): boolean;
/** 单时刻放行条件：权限允许且令牌在有效期内 */
export declare function admittedAt(timeline: readonly ChangeRecord[], token: Token, t: number): boolean;
export type WindowVerdict = "all-allowed" | "all-denied" | "mixed";
/**
 * 闭区间窗口上的放行结论。
 * 权限与令牌有效性都是右连续阶梯函数，
 * 只需采样窗口起点及窗口内全部跳变点。
 */
export declare function verdictOverWindow(timeline: readonly ChangeRecord[], token: Token, window: TimeWindow): WindowVerdict;
