import { CheckinStatus, CheckinSubmission, ZoneUtilization } from "./types";

/** 单条签到生效时长上限：10 分钟（毫秒）。 */
export const MAX_EFFECTIVE_MS = 10 * 60 * 1000;

/** 计入区域占用的状态。 */
const COUNTED_STATUSES: ReadonlySet<CheckinStatus> = new Set([
  CheckinStatus.Available,
  CheckinStatus.Working,
]);

interface EffectiveCheckin {
  eventId: number;
  occurredAt: number;
  status: CheckinStatus;
  zoneId: string;
}

/** 同一事件只保留修订号最大的版本。 */
function latestRevisions(submissions: CheckinSubmission[]): CheckinSubmission[] {
  const byEvent = new Map<number, CheckinSubmission>();
  for (const submission of submissions) {
    const current = byEvent.get(submission.eventId);
    if (current === undefined || submission.revision > current.revision) {
      byEvent.set(submission.eventId, submission);
    }
  }
  return [...byEvent.values()];
}

/**
 * 构造单个工人的有效签到时间线（按发生时间升序）。
 * 同一发生时刻有多个事件时，只采用事件编号最大的那个。
 */
function buildTimeline(submissions: CheckinSubmission[]): EffectiveCheckin[] {
  const sorted = [...submissions].sort((a, b) =>
    a.occurredAt !== b.occurredAt ? a.occurredAt - b.occurredAt : a.eventId - b.eventId,
  );
  const timeline: EffectiveCheckin[] = [];
  for (const s of sorted) {
    const last = timeline[timeline.length - 1];
    if (last !== undefined && last.occurredAt === s.occurredAt) {
      timeline[timeline.length - 1] = { eventId: s.eventId, occurredAt: s.occurredAt, status: s.status, zoneId: s.zoneId };
    } else {
      timeline.push({ eventId: s.eventId, occurredAt: s.occurredAt, status: s.status, zoneId: s.zoneId });
    }
  }
  return timeline;
}

/**
 * 依据全部有效签到，直接计算 [startMs, endMs) 内各区域累计占用时长与利用率。
 * 结果覆盖 capacities 中的全部区域（无占用时 occupiedMs 为 0）。
 */
export function computeUtilization(
  submissions: CheckinSubmission[],
  startMs: number,
  endMs: number,
  capacities: ReadonlyMap<string, number>,
): ZoneUtilization[] {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || endMs <= startMs) {
    throw new RangeError("invalid query interval: require integer startMs < endMs");
  }
  for (const [zoneId, capacity] of capacities) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`invalid capacity for zone ${zoneId}: require positive integer`);
    }
  }

  const latest = latestRevisions(submissions);
  const byWorker = new Map<number, CheckinSubmission[]>();
  for (const s of latest) {
    const list = byWorker.get(s.workerId);
    if (list === undefined) {
      byWorker.set(s.workerId, [s]);
    } else {
      list.push(s);
    }
  }

  const occupiedMsByZone = new Map<string, number>();
  for (const workerSubmissions of byWorker.values()) {
    const timeline = buildTimeline(workerSubmissions);
    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i];
      if (!COUNTED_STATUSES.has(entry.status)) continue;
      const next = timeline[i + 1];
      const effectEnd = Math.min(
        next !== undefined ? next.occurredAt : Number.MAX_SAFE_INTEGER,
        entry.occurredAt + MAX_EFFECTIVE_MS,
      );
      const overlapStart = Math.max(entry.occurredAt, startMs);
      const overlapEnd = Math.min(effectEnd, endMs);
      if (overlapEnd > overlapStart) {
        occupiedMsByZone.set(
          entry.zoneId,
          (occupiedMsByZone.get(entry.zoneId) ?? 0) + (overlapEnd - overlapStart),
        );
      }
    }
  }

  const intervalMs = endMs - startMs;
  const results: ZoneUtilization[] = [];
  for (const [zoneId, capacity] of capacities) {
    const occupiedMs = occupiedMsByZone.get(zoneId) ?? 0;
    results.push({
      zoneId,
      occupiedMs,
      utilization: occupiedMs / (capacity * intervalMs),
    });
  }
  return results;
}
