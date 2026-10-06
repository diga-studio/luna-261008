import {
  BatchChange,
  BatchResult,
  Conflict,
  ConflictReport,
  OverbookedConflict,
  ResourceKind,
  SchedulerConfig,
  Session,
  TimeRange,
  UnavailableConflict,
} from "./types";

interface ResourceLoad {
  kind: ResourceKind;
  id: string;
  capacity: number;
  /** 占用该资源的场次及其负载量 */
  occupants: { session: Session; load: number }[];
}

/** 合并重叠或相接的时段，返回并集（左闭右开） */
function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

/** 计算 [start, end) 中不被 covered 并集覆盖的子区间 */
function uncoveredRanges(start: number, end: number, covered: TimeRange[]): TimeRange[] {
  const gaps: TimeRange[] = [];
  let cursor = start;
  for (const c of covered) {
    if (c.end <= cursor) continue;
    if (c.start >= end) break;
    if (c.start > cursor) gaps.push({ start: cursor, end: Math.min(c.start, end) });
    cursor = Math.max(cursor, c.end);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps;
}

export class SkillPulseScheduler {
  private readonly instructorAvailability = new Map<string, TimeRange[]>();
  private readonly venueCapacity = new Map<string, number>();
  private sessions = new Map<string, Session>();

  constructor(config: SchedulerConfig) {
    for (const instructor of config.instructors) {
      this.instructorAvailability.set(
        instructor.id,
        mergeRanges(instructor.availability),
      );
    }
    for (const venue of config.venues) {
      this.venueCapacity.set(venue.id, venue.capacity);
    }
    for (const session of config.sessions ?? []) {
      this.validateSessionShape(session);
      if (this.sessions.has(session.id)) {
        throw new Error(`duplicate session id in initial schedule: ${session.id}`);
      }
      this.sessions.set(session.id, { ...session, traineeIds: [...session.traineeIds] });
    }
    const initialConflicts = this.findConflicts([...this.sessions.values()]);
    if (initialConflicts.length > 0) {
      throw new Error("initial schedule has conflicts");
    }
  }

  /** 返回整批变更全部应用后的最终日程的全部冲突，不改变当前日程 */
  checkBatch(changes: BatchChange[]): ConflictReport {
    const finalSessions = this.buildFinalSessions(changes);
    return { conflicts: this.findConflicts([...finalSessions.values()]) };
  }

  /** 无冲突时整批生效；有冲突时返回报告，所有场次保持原样 */
  applyBatch(changes: BatchChange[]): BatchResult {
    const finalSessions = this.buildFinalSessions(changes);
    const conflicts = this.findConflicts([...finalSessions.values()]);
    if (conflicts.length > 0) {
      return { ok: false, report: { conflicts } };
    }
    this.sessions = finalSessions;
    return { ok: true };
  }

  /** 读取当前场次 */
  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session, traineeIds: [...session.traineeIds] } : undefined;
  }

  private validateSessionShape(session: Session): void {
    if (!(session.start < session.end)) {
      throw new Error(`session ${session.id} has invalid time range`);
    }
    if (!this.instructorAvailability.has(session.instructorId)) {
      throw new Error(`unknown instructor: ${session.instructorId}`);
    }
    if (!this.venueCapacity.has(session.venueId)) {
      throw new Error(`unknown venue: ${session.venueId}`);
    }
    if (new Set(session.traineeIds).size !== session.traineeIds.length) {
      throw new Error(`session ${session.id} has duplicate trainee ids`);
    }
  }

  /** 在当前日程副本上应用整批变更，得到最终日程（不修改当前状态） */
  private buildFinalSessions(changes: BatchChange[]): Map<string, Session> {
    const seen = new Set<string>();
    for (const change of changes) {
      const id = change.kind === "delete" ? change.sessionId : change.session.id;
      if (seen.has(id)) {
        throw new Error(`session id appears more than once in batch: ${id}`);
      }
      seen.add(id);
    }

    const finalSessions = new Map<string, Session>();
    for (const [id, session] of this.sessions) {
      finalSessions.set(id, { ...session, traineeIds: [...session.traineeIds] });
    }

    for (const change of changes) {
      switch (change.kind) {
        case "add": {
          const session = change.session;
          this.validateSessionShape(session);
          if (finalSessions.has(session.id)) {
            throw new Error(`cannot add existing session id: ${session.id}`);
          }
          finalSessions.set(session.id, { ...session, traineeIds: [...session.traineeIds] });
          break;
        }
        case "replace": {
          const session = change.session;
          this.validateSessionShape(session);
          if (!finalSessions.has(session.id)) {
            throw new Error(`cannot replace missing session id: ${session.id}`);
          }
          finalSessions.set(session.id, { ...session, traineeIds: [...session.traineeIds] });
          break;
        }
        case "delete": {
          if (!finalSessions.has(change.sessionId)) {
            throw new Error(`cannot delete missing session id: ${change.sessionId}`);
          }
          finalSessions.delete(change.sessionId);
          break;
        }
      }
    }
    return finalSessions;
  }

  /** 按资源聚合占用，再分别检测 overbooked 与 unavailable */
  private findConflicts(sessions: Session[]): Conflict[] {
    const loads = new Map<string, ResourceLoad>();
    const keyOf = (kind: ResourceKind, id: string) => `${kind}:${id}`;
    const occupy = (kind: ResourceKind, id: string, capacity: number, session: Session, load: number) => {
      const key = keyOf(kind, id);
      let entry = loads.get(key);
      if (!entry) {
        entry = { kind, id, capacity, occupants: [] };
        loads.set(key, entry);
      }
      entry.occupants.push({ session, load });
    };

    for (const session of sessions) {
      occupy("instructor", session.instructorId, 1, session, 1);
      occupy("venue", session.venueId, this.venueCapacity.get(session.venueId)!, session, session.traineeIds.length);
      for (const traineeId of session.traineeIds) {
        occupy("trainee", traineeId, 1, session, 1);
      }
    }

    const conflicts: Conflict[] = [];
    for (const load of loads.values()) {
      conflicts.push(...this.findOverbooked(load));
      if (load.kind === "instructor") {
        conflicts.push(...this.findUnavailable(load.id, load.occupants.map((o) => o.session)));
      }
    }

    const kindOrder: Record<ResourceKind, number> = { instructor: 0, venue: 1, trainee: 2 };
    conflicts.sort(
      (a, b) =>
        kindOrder[a.resourceKind] - kindOrder[b.resourceKind] ||
        a.resourceId.localeCompare(b.resourceId) ||
        a.type.localeCompare(b.type) ||
        a.start - b.start ||
        a.end - b.end,
    );
    return conflicts;
  }

  /** 扫描线：负载超过容量的极大区间 */
  private findOverbooked(load: ResourceLoad): OverbookedConflict[] {
    const events: { time: number; delta: number }[] = [];
    for (const { session, load: amount } of load.occupants) {
      events.push({ time: session.start, delta: amount });
      events.push({ time: session.end, delta: -amount });
    }
    events.sort((a, b) => a.time - b.time);

    const conflicts: OverbookedConflict[] = [];
    let currentLoad = 0;
    let index = 0;
    while (index < events.length) {
      const time = events[index].time;
      while (index < events.length && events[index].time === time) {
        currentLoad += events[index].delta;
        index += 1;
      }
      const nextTime = index < events.length ? events[index].time : null;
      if (nextTime !== null && currentLoad > load.capacity && time < nextTime) {
        const sessionIds = load.occupants
          .filter((o) => o.session.start <= time && o.session.end >= nextTime)
          .map((o) => o.session.id)
          .sort();
        const last = conflicts[conflicts.length - 1];
        if (
          last &&
          last.end === time &&
          last.load === currentLoad &&
          last.sessionIds.join("") === sessionIds.join("")
        ) {
          last.end = nextTime;
        } else {
          conflicts.push({
            type: "overbooked",
            resourceKind: load.kind,
            resourceId: load.id,
            start: time,
            end: nextTime,
            load: currentLoad,
            capacity: load.capacity,
            sessionIds,
          });
        }
      }
    }
    return conflicts;
  }

  /** 教员：场次时间未被可用时段并集覆盖的部分 */
  private findUnavailable(instructorId: string, sessions: Session[]): UnavailableConflict[] {
    const availability = this.instructorAvailability.get(instructorId)!;
    const conflicts: UnavailableConflict[] = [];
    for (const session of [...sessions].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
      for (const gap of uncoveredRanges(session.start, session.end, availability)) {
        conflicts.push({
          type: "unavailable",
          resourceKind: "instructor",
          resourceId: instructorId,
          start: gap.start,
          end: gap.end,
          sessionIds: [session.id],
        });
      }
    }
    return conflicts;
  }
}
