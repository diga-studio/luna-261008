import { CHECKIN_TTL_MS, COUNTED_STATUSES } from "./types.js";
import type { CheckinEvent } from "./types.js";

/**
 * 依据全部有效签到（每事件最新修订）直接计算 [startMs, endMs) 内
 * 各区域的累计占用时长（人毫秒）。
 *
 * 语义：
 * - 不按到达顺序，按发生时间解释；同一工人同一时刻只取事件编号最大者。
 * - 一条签到从发生时刻生效，到下一条有效签到或 10 分钟后结束（取较早者）。
 * - 可用/执行任务计入所在区域；休息/离岗不计入但终止上一条签到。
 * - 区间左闭右开，到期时刻不再占用。
 */
export function computeOccupiedMs(
  events: CheckinEvent[],
  startMs: number,
  endMs: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (endMs <= startMs) return result;

  const byWorker = new Map<number, CheckinEvent[]>();
  for (const event of events) {
    // 发生时刻晚于查询区间结束的签到不可能影响本区间。
    if (event.occurredAtMs >= endMs) continue;
    const list = byWorker.get(event.workerId);
    if (list) list.push(event);
    else byWorker.set(event.workerId, [event]);
  }

  for (const workerEvents of byWorker.values()) {
    workerEvents.sort(
      (a, b) => a.occurredAtMs - b.occurredAtMs || a.eventId - b.eventId,
    );
    // 同一发生时刻只保留事件编号最大者（排序后位于同组末尾）。
    const effective: CheckinEvent[] = [];
    for (const event of workerEvents) {
      const last = effective[effective.length - 1];
      if (last && last.occurredAtMs === event.occurredAtMs) {
        effective[effective.length - 1] = event;
      } else {
        effective.push(event);
      }
    }

    for (let i = 0; i < effective.length; i++) {
      const current = effective[i];
      if (!COUNTED_STATUSES.has(current.status)) continue;
      const next = effective[i + 1];
      const intervalEnd = Math.min(
        next ? next.occurredAtMs : Number.POSITIVE_INFINITY,
        current.occurredAtMs + CHECKIN_TTL_MS,
        endMs,
      );
      const overlapStart = Math.max(current.occurredAtMs, startMs);
      if (intervalEnd > overlapStart) {
        const zone = current.zone;
        result.set(zone, (result.get(zone) ?? 0) + intervalEnd - overlapStart);
      }
    }
  }

  return result;
}
