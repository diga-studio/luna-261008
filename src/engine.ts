import { IntervalIndex } from './interval-index';
import {
  BatchResult,
  CapacityViolation,
  ConflictPair,
  EnrollmentResult,
  ResourceKind,
  ResourceRef,
  SessionInput,
  SessionView,
} from './types';

export const MAX_BATCH_SIZE = 200;
export const MIN_CAPACITY = 1;
export const MAX_CAPACITY = 50;

interface SessionRecord {
  id: string;
  instructorId: string;
  venueId: string;
  start: number;
  end: number;
  capacity: number;
  trainees: Set<string>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`SkillPulse: invalid input — ${message}`);
  }
}

function requireId(value: unknown, field: string): asserts value is string {
  requireCondition(
    typeof value === 'string' && value.length > 0,
    `${field} must be a non-empty string`,
  );
}

function validateSessionInput(input: SessionInput, context: string): void {
  requireCondition(typeof input === 'object' && input !== null, `${context}: must be an object`);
  requireId(input.id, `${context}.id`);
  requireId(input.instructorId, `${context}.instructorId`);
  requireId(input.venueId, `${context}.venueId`);
  requireCondition(
    Number.isInteger(input.start) && Number.isInteger(input.end),
    `${context}: start/end must be integer minutes`,
  );
  requireCondition(input.start < input.end, `${context}: start must be < end`);
  requireCondition(
    Number.isInteger(input.capacity) &&
      input.capacity >= MIN_CAPACITY &&
      input.capacity <= MAX_CAPACITY,
    `${context}.capacity must be an integer in [${MIN_CAPACITY}, ${MAX_CAPACITY}]`,
  );
}

function resourceKey(kind: ResourceKind, id: string): string {
  return `${kind}${id}`;
}

function compareResource(a: ResourceRef, b: ResourceRef): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface MutablePair {
  sessionIds: [string, string];
  resources: Map<string, ResourceRef>;
}

/**
 * SkillPulse 课表冲突引擎。串行调用、状态驻留内存，无持久化。
 *
 * 状态：
 *  - sessions：场次 id -> 场次记录（含已确认学员集合）；
 *  - instructorIndex / venueIndex / traineeIndex：资源 id -> 该资源的场次区间索引。
 *
 * 所有操作先算完整诊断再提交；失败时不触碰任何状态，天然原子。
 */
export class ScheduleEngine {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly instructorIndex = new Map<string, IntervalIndex>();
  private readonly venueIndex = new Map<string, IntervalIndex>();
  private readonly traineeIndex = new Map<string, IntervalIndex>();

  /**
   * 一次创建或替换最多 200 个场次，整批原子生效。
   * 替换保留该场次已确认学员；按批次全部生效后的最终课表判定冲突。
   */
  applyScheduleBatch(changes: SessionInput[]): BatchResult {
    requireCondition(Array.isArray(changes), 'changes must be an array');
    requireCondition(
      changes.length <= MAX_BATCH_SIZE,
      `batch size ${changes.length} exceeds ${MAX_BATCH_SIZE}`,
    );
    const batchIds = new Set<string>();
    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i] as SessionInput;
      validateSessionInput(change, `changes[${i}]`);
      requireCondition(!batchIds.has(change.id), `duplicate session id in batch: ${change.id}`);
      batchIds.add(change.id);
    }

    // 批次内每个场次的最终形态（替换保留已确认学员）。
    const finals: SessionRecord[] = changes.map((change) => {
      const existing = this.sessions.get(change.id);
      return { ...change, trainees: existing !== undefined ? existing.trainees : new Set() };
    });

    // 容量检查：保留的学员数不得超过新容量。
    const capacityViolations: CapacityViolation[] = [];
    for (const record of finals) {
      if (record.trainees.size > record.capacity) {
        capacityViolations.push({
          sessionId: record.id,
          capacity: record.capacity,
          enrolled: record.trainees.size,
        });
      }
    }

    const pairs = new Map<string, MutablePair>();
    const addPair = (idA: string, idB: string, kind: ResourceKind, resourceId: string): void => {
      const lo = idA < idB ? idA : idB;
      const hi = idA < idB ? idB : idA;
      const key = `${lo} ${hi}`;
      let pair = pairs.get(key);
      if (pair === undefined) {
        pair = { sessionIds: [lo, hi], resources: new Map() };
        pairs.set(key, pair);
      }
      pair.resources.set(resourceKey(kind, resourceId), { kind, id: resourceId });
    };

    // 批次内场次两两判定（B <= 200，O(B^2) = O(B)）。
    for (let i = 0; i < finals.length; i += 1) {
      const a = finals[i] as SessionRecord;
      for (let j = i + 1; j < finals.length; j += 1) {
        const b = finals[j] as SessionRecord;
        if (a.start >= b.end || b.start >= a.end) continue;
        if (a.instructorId === b.instructorId) addPair(a.id, b.id, 'instructor', a.instructorId);
        if (a.venueId === b.venueId) addPair(a.id, b.id, 'venue', a.venueId);
        const [small, large] =
          a.trainees.size <= b.trainees.size ? [a, b] : [b, a];
        for (const trainee of small.trainees) {
          if (large.trainees.has(trainee)) addPair(a.id, b.id, 'trainee', trainee);
        }
      }
    }

    // 批次内场次（新区间）对既有课表的判定。索引中批次内场次的旧区间一律跳过，
    // 它们之间的最终冲突已在上面的批内两两判定中覆盖。
    const visit = (sessionId: string, otherId: string, kind: ResourceKind, resourceId: string) =>
      addPair(sessionId, otherId, kind, resourceId);
    for (const record of finals) {
      this.instructorIndex
        .get(record.instructorId)
        ?.forEachOverlap(record.start, record.end, batchIds, (otherId) =>
          visit(record.id, otherId, 'instructor', record.instructorId),
        );
      this.venueIndex
        .get(record.venueId)
        ?.forEachOverlap(record.start, record.end, batchIds, (otherId) =>
          visit(record.id, otherId, 'venue', record.venueId),
        );
      for (const trainee of record.trainees) {
        this.traineeIndex
          .get(trainee)
          ?.forEachOverlap(record.start, record.end, batchIds, (otherId) =>
            visit(record.id, otherId, 'trainee', trainee),
          );
      }
    }

    if (pairs.size > 0 || capacityViolations.length > 0) {
      const conflicts: ConflictPair[] = [...pairs.values()]
        .map((pair) => ({
          sessionIds: pair.sessionIds,
          resources: [...pair.resources.values()].sort(compareResource),
        }))
        .sort((x, y) =>
          x.sessionIds[0] !== y.sessionIds[0]
            ? x.sessionIds[0] < y.sessionIds[0]
              ? -1
              : 1
            : x.sessionIds[1] < y.sessionIds[1]
              ? -1
              : x.sessionIds[1] > y.sessionIds[1]
                ? 1
                : 0,
        );
      capacityViolations.sort((x, y) => (x.sessionId < y.sessionId ? -1 : 1));
      return { ok: false, conflicts, capacityViolations };
    }

    // 提交：先撤旧区间，再写新区间。
    for (const record of finals) {
      const old = this.sessions.get(record.id);
      if (old !== undefined) this.removeFromIndexes(old);
      this.sessions.set(record.id, record);
      this.addToIndexes(record);
    }
    return { ok: true };
  }

  /** 加入或退出指定场次。重复加入/退出为空操作。 */
  setEnrollment(sessionId: string, traineeId: string, enrolled: boolean): EnrollmentResult {
    requireId(sessionId, 'sessionId');
    requireId(traineeId, 'traineeId');
    requireCondition(typeof enrolled === 'boolean', 'enrolled must be a boolean');
    const record = this.sessions.get(sessionId);
    requireCondition(record !== undefined, `unknown session: ${sessionId}`);

    if (!enrolled) {
      if (!record.trainees.delete(traineeId)) return { ok: true };
      this.traineeIndex.get(traineeId)?.remove(sessionId, record.start);
      return { ok: true };
    }

    if (record.trainees.has(traineeId)) return { ok: true };

    const conflicts: { sessionId: string; start: number; end: number }[] = [];
    this.traineeIndex.get(traineeId)?.forEachOverlap(record.start, record.end, null, (otherId, start, end) => {
      conflicts.push({ sessionId: otherId, start, end });
    });
    conflicts.sort((x, y) => (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0));

    let capacityViolation: CapacityViolation | undefined;
    if (record.trainees.size >= record.capacity) {
      capacityViolation = {
        sessionId: record.id,
        capacity: record.capacity,
        enrolled: record.trainees.size,
      };
    }

    if (conflicts.length > 0 || capacityViolation !== undefined) {
      return { ok: false, conflicts, capacityViolation };
    }

    record.trainees.add(traineeId);
    this.indexOf(this.traineeIndex, traineeId).insert(sessionId, record.start, record.end);
    return { ok: true };
  }

  /** 读取当前场次及其已确认学员（学员按字典序）。 */
  getSession(sessionId: string): SessionView | undefined {
    requireId(sessionId, 'sessionId');
    const record = this.sessions.get(sessionId);
    if (record === undefined) return undefined;
    return {
      id: record.id,
      instructorId: record.instructorId,
      venueId: record.venueId,
      start: record.start,
      end: record.end,
      capacity: record.capacity,
      trainees: [...record.trainees].sort(),
    };
  }

  private indexOf(map: Map<string, IntervalIndex>, resourceId: string): IntervalIndex {
    let index = map.get(resourceId);
    if (index === undefined) {
      index = new IntervalIndex();
      map.set(resourceId, index);
    }
    return index;
  }

  private addToIndexes(record: SessionRecord): void {
    this.indexOf(this.instructorIndex, record.instructorId).insert(record.id, record.start, record.end);
    this.indexOf(this.venueIndex, record.venueId).insert(record.id, record.start, record.end);
    for (const trainee of record.trainees) {
      this.indexOf(this.traineeIndex, trainee).insert(record.id, record.start, record.end);
    }
  }

  private removeFromIndexes(record: SessionRecord): void {
    this.instructorIndex.get(record.instructorId)?.remove(record.id, record.start);
    this.venueIndex.get(record.venueId)?.remove(record.id, record.start);
    for (const trainee of record.trainees) {
      this.traineeIndex.get(trainee)?.remove(record.id, record.start);
    }
  }
}
