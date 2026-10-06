import { IntervalTree } from './intervalTree.js';
import type {
  BatchResult,
  CapacityViolation,
  ConflictReport,
  ConflictResource,
  EnrollmentResult,
  OverlapConflict,
  SessionInput,
  SessionState,
} from './types.js';

const MAX_BATCH = 200;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 50;

interface InternalSession {
  id: string;
  instructorId: string;
  venueId: string;
  start: number;
  end: number;
  capacity: number;
  trainees: Set<string>;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emptyReport(): ConflictReport {
  return { overlaps: [], capacityViolations: [] };
}

export class SkillPulseEngine {
  private readonly sessions = new Map<string, InternalSession>();
  /** 全局场次区间索引，key 为场次 id。 */
  private readonly sessionIndex = new IntervalTree<string>(compareStrings);
  /** 每个学员的已确认场次区间索引，key 为场次 id。 */
  private readonly traineeIndex = new Map<string, IntervalTree<string>>();

  applyScheduleBatch(changes: SessionInput[]): BatchResult {
    this.validateBatch(changes);

    const batchIds = new Set<string>();
    const changeById = new Map<string, SessionInput>();
    for (const c of changes) {
      batchIds.add(c.id);
      changeById.set(c.id, c);
    }

    // 每个批次场次的最终学员集合：替换保留已确认学员，新建为空。
    const finalTrainees = new Map<string, Set<string>>();
    for (const c of changes) {
      const old = this.sessions.get(c.id);
      finalTrainees.set(c.id, old ? old.trainees : new Set<string>());
    }

    const overlapMap = new Map<string, OverlapConflict>();

    const addPair = (aId: string, bId: string): void => {
      const [lo, hi] = compareStrings(aId, bId) < 0 ? [aId, bId] : [bId, aId];
      const pairKey = lo + '' + hi;
      if (overlapMap.has(pairKey)) return;
      const a = this.finalSession(aId, changeById);
      const b = this.finalSession(bId, changeById);
      const resources = sharedResources(a, b, finalTrainees);
      if (resources.length > 0) {
        overlapMap.set(pairKey, { sessionIds: [lo, hi], resources });
      }
    };

    // (批次, 现有非批次) 对：查询全局索引，跳过批次内 id（旧区间不参与判断）。
    for (const c of changes) {
      this.sessionIndex.queryOverlaps(c.start, c.end, (otherId) => {
        if (!batchIds.has(otherId)) addPair(c.id, otherId);
      });
    }

    // (批次, 批次) 对：按 start 排序后扫描。
    const sorted = [...changes].sort((a, b) =>
      a.start !== b.start ? a.start - b.start : compareStrings(a.id, b.id),
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
        addPair(sorted[i].id, sorted[j].id);
      }
    }

    // 容量检查（替换场次保留的学员可能超过新 capacity）。
    const capacityViolations: CapacityViolation[] = [];
    for (const c of changes) {
      const enrolled = finalTrainees.get(c.id)!.size;
      if (enrolled > c.capacity) {
        capacityViolations.push({ sessionId: c.id, capacity: c.capacity, enrolled });
      }
    }

    if (overlapMap.size > 0 || capacityViolations.length > 0) {
      const report = emptyReport();
      report.overlaps = [...overlapMap.values()].sort(compareOverlaps);
      report.capacityViolations = capacityViolations.sort((a, b) =>
        compareStrings(a.sessionId, b.sessionId),
      );
      return { ok: false, report };
    }

    // 全部通过，提交变更。
    for (const c of changes) {
      const old = this.sessions.get(c.id);
      const trainees = finalTrainees.get(c.id)!;
      if (old) {
        this.sessionIndex.remove(old.id, old.start);
        if (old.start !== c.start || old.end !== c.end) {
          for (const t of trainees) {
            this.traineeRemove(t, old.id, old.start);
          }
        }
      }
      const session: InternalSession = { ...c, trainees };
      this.sessions.set(c.id, session);
      this.sessionIndex.insert(c.id, c.start, c.end);
      if (!old || old.start !== c.start || old.end !== c.end) {
        for (const t of trainees) {
          this.traineeInsert(t, c.id, c.start, c.end);
        }
      }
    }
    return { ok: true };
  }

  setEnrollment(sessionId: string, traineeId: string, enrolled: boolean): EnrollmentResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`setEnrollment: unknown session "${sessionId}"`);
    }

    if (enrolled) {
      if (session.trainees.has(traineeId)) return { ok: true }; // 重复加入：空操作

      const report = emptyReport();
      if (session.trainees.size >= session.capacity) {
        report.capacityViolations.push({
          sessionId,
          capacity: session.capacity,
          enrolled: session.trainees.size + 1,
        });
      }
      const tree = this.traineeIndex.get(traineeId);
      if (tree) {
        const pairs: OverlapConflict[] = [];
        tree.queryOverlaps(session.start, session.end, (otherId) => {
          const [lo, hi] =
            compareStrings(sessionId, otherId) < 0
              ? [sessionId, otherId]
              : [otherId, sessionId];
          pairs.push({
            sessionIds: [lo, hi],
            resources: [{ kind: 'trainee', id: traineeId }],
          });
        });
        pairs.sort(compareOverlaps);
        report.overlaps = pairs;
      }
      if (report.overlaps.length > 0 || report.capacityViolations.length > 0) {
        return { ok: false, report };
      }

      session.trainees.add(traineeId);
      this.traineeInsert(traineeId, sessionId, session.start, session.end);
      return { ok: true };
    }

    // 退出
    if (!session.trainees.has(traineeId)) return { ok: true }; // 重复退出：空操作
    session.trainees.delete(traineeId);
    this.traineeRemove(traineeId, sessionId, session.start);
    return { ok: true };
  }

  getSession(sessionId: string): SessionState | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      id: s.id,
      instructorId: s.instructorId,
      venueId: s.venueId,
      start: s.start,
      end: s.end,
      capacity: s.capacity,
      trainees: [...s.trainees].sort(compareStrings),
    };
  }

  private finalSession(id: string, changeById: Map<string, SessionInput>): SessionInput {
    return changeById.get(id) ?? this.sessions.get(id)!;
  }

  private traineeTree(traineeId: string): IntervalTree<string> {
    let tree = this.traineeIndex.get(traineeId);
    if (!tree) {
      tree = new IntervalTree<string>(compareStrings);
      this.traineeIndex.set(traineeId, tree);
    }
    return tree;
  }

  private traineeInsert(traineeId: string, sessionId: string, start: number, end: number): void {
    this.traineeTree(traineeId).insert(sessionId, start, end);
  }

  private traineeRemove(traineeId: string, sessionId: string, start: number): void {
    const tree = this.traineeIndex.get(traineeId);
    if (!tree) return;
    tree.remove(sessionId, start);
    if (tree.size === 0) this.traineeIndex.delete(traineeId);
  }

  private validateBatch(changes: SessionInput[]): void {
    if (!Array.isArray(changes)) throw new TypeError('changes must be an array');
    if (changes.length > MAX_BATCH) {
      throw new RangeError(`batch size ${changes.length} exceeds ${MAX_BATCH}`);
    }
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.id)) throw new Error(`duplicate session id in batch: "${c.id}"`);
      seen.add(c.id);
      if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start >= c.end) {
        throw new RangeError(`session "${c.id}": invalid interval [${c.start}, ${c.end})`);
      }
      if (
        !Number.isInteger(c.capacity) ||
        c.capacity < MIN_CAPACITY ||
        c.capacity > MAX_CAPACITY
      ) {
        throw new RangeError(`session "${c.id}": capacity must be 1..${MAX_CAPACITY}`);
      }
    }
  }
}

function sharedResources(
  a: SessionInput,
  b: SessionInput,
  finalTrainees: Map<string, Set<string>>,
): ConflictResource[] {
  const resources: ConflictResource[] = [];
  if (a.instructorId === b.instructorId) {
    resources.push({ kind: 'instructor', id: a.instructorId });
  }
  if (a.venueId === b.venueId) {
    resources.push({ kind: 'venue', id: a.venueId });
  }
  const ta = traineesOf(a.id, a, finalTrainees);
  const tb = traineesOf(b.id, b, finalTrainees);
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  const shared: string[] = [];
  for (const t of small) {
    if (large.has(t)) shared.push(t);
  }
  shared.sort(compareStrings);
  for (const t of shared) resources.push({ kind: 'trainee', id: t });
  return resources;
}

function traineesOf(
  id: string,
  session: SessionInput,
  finalTrainees: Map<string, Set<string>>,
): Set<string> {
  const carried = finalTrainees.get(id);
  if (carried) return carried;
  return (session as InternalSession).trainees;
}

function compareOverlaps(a: OverlapConflict, b: OverlapConflict): number {
  return (
    compareStrings(a.sessionIds[0], b.sessionIds[0]) ||
    compareStrings(a.sessionIds[1], b.sessionIds[1])
  );
}
