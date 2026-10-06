"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.alignSubtitleTrack = exports.MIN_GAP_MS = void 0;
const isotonic_1 = require("./isotonic");
/** 相邻两段字幕之间的最小间隔（毫秒） */
exports.MIN_GAP_MS = 80;
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
function alignSubtitleTrack(segments, videoDuration) {
    const n = segments.length;
    if (n === 0) {
        return { ok: true, segments: [], totalCost: 0n };
    }
    const varCount = 2 * n;
    // a[j]：变量 j 的原时刻；w[j]：变量 j 的权重；c[j]：x[j+1] - x[j] 的下限
    const a = new Array(varCount);
    const w = new Array(varCount);
    const c = new Array(varCount - 1);
    const lockedVar = new Array(varCount);
    for (let i = 0; i < n; i++) {
        const seg = segments[i];
        a[2 * i] = seg.start;
        a[2 * i + 1] = seg.end;
        w[2 * i] = seg.weight;
        w[2 * i + 1] = seg.weight;
        c[2 * i] = seg.minDuration;
        if (2 * i + 1 < varCount - 1)
            c[2 * i + 1] = exports.MIN_GAP_MS;
        lockedVar[2 * i] = seg.locked;
        lockedVar[2 * i + 1] = seg.locked;
        // 锁定段自身必须满足最低展示时长（其余输入合法性由调用方保证）
        if (seg.locked && seg.end - seg.start < seg.minDuration) {
            return { ok: false };
        }
    }
    // C[j] = sum_{k<j} c[k]，y[j] = x[j] - C[j] 单调不降
    const prefix = new Array(varCount);
    prefix[0] = 0;
    for (let j = 1; j < varCount; j++) {
        prefix[j] = prefix[j - 1] + c[j - 1];
    }
    const b = new Array(varCount);
    for (let j = 0; j < varCount; j++) {
        b[j] = a[j] - prefix[j];
    }
    // 锁定变量的 y 值
    const lockedY = new Array(varCount);
    for (let j = 0; j < varCount; j++) {
        lockedY[j] = b[j];
    }
    // 相邻锁定变量之间没有自由区间，必须直接满足单调性
    for (let j = 0; j + 1 < varCount; j++) {
        if (lockedVar[j] && lockedVar[j + 1] && lockedY[j] > lockedY[j + 1]) {
            return { ok: false };
        }
    }
    // 全局右边界：y[varCount-1] <= videoDuration - C[varCount-1]
    const globalUpper = videoDuration - prefix[varCount - 1];
    const y = new Array(varCount);
    let runStart = 0;
    while (runStart < varCount) {
        if (lockedVar[runStart]) {
            y[runStart] = lockedY[runStart];
            runStart++;
            continue;
        }
        let runEnd = runStart;
        while (runEnd + 1 < varCount && !lockedVar[runEnd + 1]) {
            runEnd++;
        }
        // 自由区间 [runStart, runEnd] 的上下界（由左右锚点决定）
        const lower = runStart > 0 ? lockedY[runStart - 1] : 0;
        const upper = runEnd + 1 < varCount ? lockedY[runEnd + 1] : globalUpper;
        if (lower > upper) {
            return { ok: false };
        }
        const runB = b.slice(runStart, runEnd + 1);
        const runW = w.slice(runStart, runEnd + 1);
        const solved = (0, isotonic_1.isotonicL1Min)(runB, runW);
        for (let j = runStart; j <= runEnd; j++) {
            let v = solved[j - runStart];
            if (v < lower)
                v = lower;
            else if (v > upper)
                v = upper;
            y[j] = v;
        }
        runStart = runEnd + 1;
    }
    // 还原 x 并校验相邻锁定变量之间的次序（空自由区间时上界检查已覆盖）
    const out = new Array(n);
    let totalCost = 0n;
    for (let i = 0; i < n; i++) {
        const start = y[2 * i] + prefix[2 * i];
        const end = y[2 * i + 1] + prefix[2 * i + 1];
        out[i] = { start, end };
        const weight = BigInt(segments[i].weight);
        totalCost +=
            weight * BigInt(Math.abs(start - segments[i].start)) +
                weight * BigInt(Math.abs(end - segments[i].end));
    }
    return { ok: true, segments: out, totalCost };
}
exports.alignSubtitleTrack = alignSubtitleTrack;
