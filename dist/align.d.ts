import type { AlignResult, SegmentInput } from "./types";
/** 相邻两段字幕之间的最小间隔（毫秒） */
export declare const MIN_GAP_MS = 80;
/**
 * 对一条字幕轨道做全局校时。
 *
 * 模型：把每段的 (开始, 结束) 依次排成链式变量 x[1..2n]。
 * 约束 x[j+1] >= x[j] + c[j]，其中奇数间隔为该段最低展示时长、
 * 偶数间隔为段间最小间隔 MIN_GAP_MS；另有 x[1] >= 0、x[2n] <= 视频时长。
 * 令 y[j] = x[j] - C[j]（C 为 c 的前缀和），问题化为加权 L1 保序回归，
 * 锁定段把链切成若干独立自由区间，分别求解后按区间边界截断即可。
 *
 * @param segments 按对白顺序排列的字幕段
 * @param videoDuration 视频总时长（毫秒）
 * @returns 调整后的时间轴与总偏移成本；约束无法同时满足时返回 { ok: false }
 */
export declare function alignSubtitleTrack(segments: readonly SegmentInput[], videoDuration: number): AlignResult;
