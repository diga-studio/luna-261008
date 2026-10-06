import type { ChangeRecord, TimeWindow, Token } from "./types.js";

/** 按 (effectiveTime, seq) 排序后的某身份变更时间线 */
export type Timeline = readonly ChangeRecord[];

export function buildTimeline(changes: ChangeRecord[]): Timeline {
  return [...changes].sort((a, b) =>
    a.effectiveTime !== b.effectiveTime ? a.effectiveTime - b.effectiveTime : a.seq - b.seq,
  );
}

/** 时刻 t 是否准入：首次变更之前视为拒绝 */
export function allowedAt(timeline: Timeline, t: number): boolean {
  let lo = 0;
  let hi = timeline.length; // 找最后一个 effectiveTime <= t 的变更
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid]!.effectiveTime <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return false;
  const c = timeline[lo - 1]!;
  return c.status === "active" && c.allowEntry && !c.blacklisted;
}

/** 令牌在时刻 t 是否有效：左闭右开 */
export function tokenValidAt(token: Token, t: number): boolean {
  return t >= token.validFrom && t < token.validTo;
}

/** 窗口内每个整数时刻都满足 (准入且令牌有效) 时为 true */
export function okThroughout(timeline: Timeline, token: Token, window: TimeWindow): boolean {
  return classify(timeline, token, window) === "all";
}

export type Coverage = "all" | "none" | "mixed";

/** 对闭区间 [start,end] 内所有整数时刻分类：全部满足 / 全部不满足 / 两者皆有 */
export function classify(timeline: Timeline, token: Token, window: TimeWindow): Coverage {
  if (window.start > window.end) return "none";
  const ok = (t: number): boolean => allowedAt(timeline, t) && tokenValidAt(token, t);
  // ok 是分段常量函数，跳变点只可能出现在：变更生效时刻、validFrom、validTo
  const samples: number[] = [window.start];
  for (const c of timeline) {
    if (c.effectiveTime > window.start && c.effectiveTime <= window.end) {
      samples.push(c.effectiveTime);
    }
  }
  if (token.validFrom > window.start && token.validFrom <= window.end) samples.push(token.validFrom);
  if (token.validTo > window.start && token.validTo <= window.end) samples.push(token.validTo);
  let sawOk = false;
  let sawBad = false;
  for (const t of samples) {
    if (ok(t)) sawOk = true;
    else sawBad = true;
    if (sawOk && sawBad) return "mixed";
  }
  return sawOk ? "all" : "none";
}
