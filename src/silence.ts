/** 静默窗口：UTC+8 每日 22:00（含）至次日 06:00（不含） */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UTC_PLUS_8_MS = 8 * HOUR_MS;
const SILENCE_START_HOUR = 22;
const SILENCE_END_HOUR = 6;

/** 判断给定 UTC 毫秒时刻是否处于静默窗口内 */
export function isInSilenceWindow(timeMs: number): boolean {
  const shanghaiTimeOfDay =
    ((timeMs + UTC_PLUS_8_MS) % DAY_MS + DAY_MS) % DAY_MS;
  return (
    shanghaiTimeOfDay >= SILENCE_START_HOUR * HOUR_MS ||
    shanghaiTimeOfDay < SILENCE_END_HOUR * HOUR_MS
  );
}

/** 返回严格大于 afterMs 的下一个静默结束时刻（UTC+8 06:00，即 UTC 22:00） */
export function nextSilenceEndAfter(afterMs: number): number {
  // UTC+8 当日 06:00 对应的 UTC 毫秒
  const shanghaiMidnightUtc =
    Math.floor((afterMs + UTC_PLUS_8_MS) / DAY_MS) * DAY_MS - UTC_PLUS_8_MS;
  let boundary = shanghaiMidnightUtc + SILENCE_END_HOUR * HOUR_MS;
  if (boundary <= afterMs) {
    boundary += DAY_MS;
  }
  return boundary;
}
