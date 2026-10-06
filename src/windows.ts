import type { PlaybackConfig, ShiftWindow } from "./types.js";
import { localWallToUtc, utcToLocalDate } from "./timezone.js";

const DAY_MS = 86_400_000;

/** 某窗口在某个本地日历日生成的 UTC 实例；endUtcMs <= startUtcMs 视为空。 */
export interface WindowInstance {
  def: ShiftWindow;
  startUtcMs: number;
  endUtcMs: number;
}

/** 生成某个窗口定义在某个本地日历日的 UTC 实例。 */
export function instanceForLocalDate(
  def: ShiftWindow,
  year: number,
  month: number,
  day: number,
): WindowInstance {
  const startUtcMs = localWallToUtc(year, month, day, def.startLocal, "earlier");
  // 结束钟面早于开始钟面 -> 归到次日；相等则当日即空窗口。
  const endNextDay = def.endLocal < def.startLocal;
  const endDate = new Date(Date.UTC(year, month - 1, day + (endNextDay ? 1 : 0)));
  const endUtcMs = localWallToUtc(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth() + 1,
    endDate.getUTCDate(),
    def.endLocal,
    "later",
  );
  return { def, startUtcMs, endUtcMs };
}

/** 生成与 [fromUtcMs, toUtcMs) 可能相交的全部窗口实例（按本地日历逐日展开）。 */
export function windowInstancesIntersecting(
  config: PlaybackConfig,
  group: string,
  fromUtcMs: number,
  toUtcMs: number,
): WindowInstance[] {
  const defs = config.windows.filter((w) => w.group === group);
  if (defs.length === 0 || fromUtcMs >= toUtcMs) return [];
  // 窗口名义跨度 <= 12h（回拨日最多 13h），只需向前多展开一个本地日即可覆盖跨午夜溢出。
  const fromDate = utcToLocalDate(fromUtcMs);
  const toDate = utcToLocalDate(toUtcMs - 1);
  const firstDayUtc = Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day - 1);
  const lastDayUtc = Date.UTC(toDate.year, toDate.month - 1, toDate.day);
  const out: WindowInstance[] = [];
  for (let dayUtc = firstDayUtc; dayUtc <= lastDayUtc; dayUtc += DAY_MS) {
    const d = new Date(dayUtc);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    for (const def of defs) {
      const inst = instanceForLocalDate(def, y, m, day);
      if (inst.endUtcMs <= inst.startUtcMs) continue; // 转换后为空的当日窗口
      if (inst.startUtcMs < toUtcMs && inst.endUtcMs > fromUtcMs) out.push(inst);
    }
  }
  return out;
}

/** t 时刻该 group 获选的窗口实例（priority 最高，并列取 id 字典序最小），无则 null。 */
export function selectWindowAt(
  config: PlaybackConfig,
  group: string,
  tUtcMs: number,
): WindowInstance | null {
  const active = windowInstancesIntersecting(config, group, tUtcMs, tUtcMs + 1).filter(
    (inst) => inst.startUtcMs <= tUtcMs && tUtcMs < inst.endUtcMs,
  );
  if (active.length === 0) return null;
  active.sort((a, b) => b.def.priority - a.def.priority || (a.def.id < b.def.id ? -1 : 1));
  return active[0];
}
