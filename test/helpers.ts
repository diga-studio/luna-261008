import { CheckinStatus, CheckinSubmission } from "../src/types";

const MAX_EFFECTIVE_MS = 10 * 60 * 1000;
const COUNTED = new Set([CheckinStatus.Available, CheckinStatus.Working]);

/**
 * 独立参考实现：与库内算法结构不同。
 * 先收集区间内全部边界点，再对每个基本小段用“时刻 t 的占用状态”函数
 * 逐工人判定所属区域，按段长累加。
 */
export function referenceOccupiedMs(
  submissions: CheckinSubmission[],
  startMs: number,
  endMs: number,
): Map<string, number> {
  // 同一事件取最大修订号
  const byEvent = new Map<number, CheckinSubmission>();
  for (const s of submissions) {
    const cur = byEvent.get(s.eventId);
    if (cur === undefined || s.revision > cur.revision) byEvent.set(s.eventId, s);
  }
  // 按工人分组
  const byWorker = new Map<number, CheckinSubmission[]>();
  for (const s of byEvent.values()) {
    const list = byWorker.get(s.workerId) ?? [];
    list.push(s);
    byWorker.set(s.workerId, list);
  }

  // 时刻 t 某工人计入的区域（不计入返回 null）
  function zoneAt(workerSubs: CheckinSubmission[], t: number): string | null {
    let best: CheckinSubmission | null = null;
    for (const s of workerSubs) {
      if (s.occurredAt > t) continue;
      if (
        best === null ||
        s.occurredAt > best.occurredAt ||
        (s.occurredAt === best.occurredAt && s.eventId > best.eventId)
      ) {
        best = s;
      }
    }
    if (best === null) return null;
    if (t >= best.occurredAt + MAX_EFFECTIVE_MS) return null; // 已到期
    if (!COUNTED.has(best.status)) return null;
    return best.zoneId;
  }

  // 收集边界点
  const boundaries = new Set<number>([startMs, endMs]);
  for (const subs of byWorker.values()) {
    for (const s of subs) {
      if (s.occurredAt > startMs && s.occurredAt < endMs) boundaries.add(s.occurredAt);
      const expiry = s.occurredAt + MAX_EFFECTIVE_MS;
      if (expiry > startMs && expiry < endMs) boundaries.add(expiry);
    }
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const occupied = new Map<string, number>();
  for (let i = 0; i + 1 < points.length; i++) {
    const segStart = points[i];
    const segEnd = points[i + 1];
    if (segEnd <= segStart) continue;
    const mid = segStart; // 左闭右开：段内状态与段起点一致
    for (const subs of byWorker.values()) {
      const zone = zoneAt(subs, mid);
      if (zone !== null) {
        occupied.set(zone, (occupied.get(zone) ?? 0) + (segEnd - segStart));
      }
    }
  }
  return occupied;
}

/** 确定性伪随机数生成器（mulberry32）。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = [
  CheckinStatus.Available,
  CheckinStatus.Working,
  CheckinStatus.Rest,
  CheckinStatus.OffDuty,
];

/** 生成一批随机提交（含乱序、修订、重复提交）。 */
export function randomSubmissions(
  rng: () => number,
  count: number,
  workerCount: number,
  zoneIds: string[],
  timeMin: number,
  timeMax: number,
): CheckinSubmission[] {
  const out: CheckinSubmission[] = [];
  let nextEventId = 1;
  const revisionsByEvent = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const isRevision = nextEventId > 1 && rng() < 0.35;
    let eventId: number;
    if (isRevision) {
      eventId = 1 + Math.floor(rng() * (nextEventId - 1));
      const prev = revisionsByEvent.get(eventId) ?? 0;
      // 偶尔重复提交相同修订号（内容一致）
      const revision = rng() < 0.3 ? prev : prev + 1;
      revisionsByEvent.set(eventId, revision);
      const workerId = workerOf(eventId, workerCount);
      out.push({
        eventId,
        workerId,
        occurredAt: timeMin + Math.floor(rng() * (timeMax - timeMin)),
        status: STATUSES[Math.floor(rng() * STATUSES.length)],
        zoneId: zoneIds[Math.floor(rng() * zoneIds.length)],
        revision,
      });
    } else {
      eventId = nextEventId++;
      revisionsByEvent.set(eventId, 0);
      out.push({
        eventId,
        workerId: workerOf(eventId, workerCount),
        occurredAt: timeMin + Math.floor(rng() * (timeMax - timeMin)),
        status: STATUSES[Math.floor(rng() * STATUSES.length)],
        zoneId: zoneIds[Math.floor(rng() * zoneIds.length)],
        revision: 0,
      });
    }
  }
  return out;
}

function workerOf(eventId: number, workerCount: number): number {
  return (eventId * 7919) % workerCount + 1;
}
