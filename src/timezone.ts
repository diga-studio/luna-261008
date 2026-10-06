/** America/New_York 本地钟面 ↔ UTC 转换。 */

const TZ = "America/New_York";
const HOUR_MS = 3_600_000;

export type AmbiguousPreference = "earlier" | "later";

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function localParts(utcMs: number): LocalParts {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of dtf.formatToParts(utcMs)) {
    if (p.type !== "literal") {
      (out as Record<string, number>)[p.type] = Number(p.value);
    }
  }
  return out;
}

/** 该 UTC 瞬间的本地偏移（毫秒）：本地钟面 - UTC。 */
function offsetMs(utcMs: number): number {
  const p = localParts(utcMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - (utcMs - (utcMs % 1000));
}

/** 把 UTC 瞬间转换为本地日历日组件（公历年月日）。 */
export function utcToLocalDate(utcMs: number): { year: number; month: number; day: number } {
  const p = localParts(utcMs);
  return { year: p.year, month: p.month, day: p.day };
}

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(":");
  return { hour: Number(h), minute: Number(m) };
}

function matches(utcMs: number, y: number, mo: number, d: number, h: number, mi: number): boolean {
  const p = localParts(utcMs);
  return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi;
}

/**
 * 把某本地日历日的 "HH:mm" 钟面时间转换为 UTC 毫秒。
 * 回拨重复时刻：pref 决定取较早/较晚瞬间。
 * 春季不存在的时刻：向前移动实际缺失时长（如 02:30 -> 03:30）。
 */
export function localWallToUtc(
  year: number,
  month: number,
  day: number,
  hhmm: string,
  pref: AmbiguousPreference,
): number {
  const { hour, minute } = parseHhmm(hhmm);
  // 把目标钟面先当作 UTC 得到基准点 t0；真实瞬间落在 t0+4h~t0+5h（NY 偏移 -5/-4），
  // 在 t0+4h 与 t0+8h 各探一次偏移，可覆盖跳变前后两个分支（含重复时刻的两个瞬间）。
  const t0 = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = new Set<number>();
  for (const probe of [t0, t0 + 4 * HOUR_MS, t0 + 8 * HOUR_MS]) {
    candidates.add(t0 - offsetMs(probe));
  }
  const valid = [...candidates].filter((c) => matches(c, year, month, day, hour, minute));
  if (valid.length > 0) {
    return pref === "earlier" ? Math.min(...valid) : Math.max(...valid);
  }
  // 时刻不存在（春季跳时）：缺失时长 = 跳变后偏移 - 跳变前偏移，把钟面向前平移该时长。
  const gapMs = offsetMs(t0 + 8 * HOUR_MS) - offsetMs(t0 + 4 * HOUR_MS);
  if (gapMs <= 0) {
    throw new Error(`unresolvable local time: ${year}-${month}-${day} ${hhmm}`);
  }
  const shifted = new Date(t0 + gapMs);
  return localWallToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`,
    pref,
  );
}
