import {
  CHECKIN_TTL_MS,
  COUNTED_STATUSES,
  type CheckinEvent,
} from "../src/index.js";

/**
 * 独立校验器：与引擎实现不同的“关键时间点分段 + 中点状态扫描”方法，
 * 依据全部有效签到直接计算 [startMs, endMs) 内各区域累计占用时长。
 */
export function bruteForceOccupiedMs(
  submitted: CheckinEvent[],
  startMs: number,
  endMs: number,
): Map<string, number> {
  // 每个事件只保留修订号最大的版本。
  const latest = new Map<number, CheckinEvent>();
  for (const event of submitted) {
    const prev = latest.get(event.eventId);
    if (!prev || event.revision > prev.revision) latest.set(event.eventId, event);
  }

  // 按工人分组，按 (发生时间, 事件编号) 排序，同一时刻只留编号最大者。
  const byWorker = new Map<number, CheckinEvent[]>();
  for (const event of latest.values()) {
    const list = byWorker.get(event.workerId) ?? [];
    list.push(event);
    byWorker.set(event.workerId, list);
  }
  for (const list of byWorker.values()) {
    list.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventId - b.eventId);
    for (let i = list.length - 1; i > 0; i--) {
      if (list[i].occurredAtMs === list[i - 1].occurredAtMs) list.splice(i - 1, 1);
    }
  }

  // 关键时间点：区间端点、区间内签到时刻、区间内到期时刻。
  const points = new Set<number>([startMs, endMs]);
  for (const list of byWorker.values()) {
    for (const event of list) {
      for (const t of [event.occurredAtMs, event.occurredAtMs + CHECKIN_TTL_MS]) {
        if (t > startMs && t < endMs) points.add(t);
      }
    }
  }
  const sorted = [...points].sort((a, b) => a - b);

  const result = new Map<string, number>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const segStart = sorted[i];
    const segLen = sorted[i + 1] - segStart;
    if (segLen <= 0) continue;
    for (const list of byWorker.values()) {
      // 找到 segStart 时刻之前（含）最近的一条有效签到。
      let active: CheckinEvent | undefined;
      for (const event of list) {
        if (event.occurredAtMs <= segStart) active = event;
        else break;
      }
      if (!active) continue;
      if (!COUNTED_STATUSES.has(active.status)) continue;
      if (segStart >= active.occurredAtMs + CHECKIN_TTL_MS) continue;
      result.set(active.zone, (result.get(active.zone) ?? 0) + segLen);
    }
  }
  return result;
}

let nextEventId = 1;

export function resetEventIds(): void {
  nextEventId = 1;
}

export function makeEvent(partial: Omit<CheckinEvent, "eventId"> & { eventId?: number }): CheckinEvent {
  const { eventId, ...rest } = partial;
  return { eventId: eventId ?? nextEventId++, ...rest };
}
