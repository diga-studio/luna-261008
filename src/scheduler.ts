import type {
  BatchChange,
  Conflict,
  OverbookedConflict,
  ResourceConfig,
  ResourceType,
  Session,
  TimeRange,
  UnavailableConflict,
} from "./types.ts";

function validateSession(session: Session): void {
  if (
    !Number.isInteger(session.start) ||
    !Number.isInteger(session.end) ||
    session.start >= session.end
  ) {
    throw new Error(
      `session ${session.id}: invalid time range [${session.start}, ${session.end})`,
    );
  }
}

function mergeWindows(windows: TimeRange[]): TimeRange[] {
  const sorted = windows
    .map((w) => ({ start: w.start, end: w.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TimeRange[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
    } else {
      merged.push({ start: w.start, end: w.end });
    }
  }
  return merged;
}

interface Usage {
  session: Session;
  weight: number;
}

function detectOverbooked(
  resourceType: ResourceType,
  resourceId: string,
  capacity: number,
  usages: Usage[],
): OverbookedConflict[] {
  const deltas = new Map<number, number>();
  for (const u of usages) {
    deltas.set(u.session.start, (deltas.get(u.session.start) ?? 0) + u.weight);
    deltas.set(u.session.end, (deltas.get(u.session.end) ?? 0) - u.weight);
  }
  const points = [...deltas.keys()].sort((a, b) => a - b);
  const conflicts: OverbookedConflict[] = [];
  let load = 0;
  let open: OverbookedConflict | null = null;
  const ids = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    const t = points[i];
    const next = i + 1 < points.length ? points[i + 1] : null;
    if (open && load <= capacity) {
      open.sessionIds = [...ids].sort();
      conflicts.push(open);
      open = null;
      ids.clear();
    }
    load += deltas.get(t)!;
    if (next !== null && load > capacity) {
      if (!open) {
        open = {
          kind: "overbooked",
          resourceType,
          resourceId,
          start: t,
          end: next,
          load,
          capacity,
          sessionIds: [],
        };
      } else {
        open.end = next;
        open.load = Math.max(open.load, load);
      }
      for (const u of usages) {
        if (u.session.start <= t && u.session.end >= next) {
          ids.add(u.session.id);
        }
      }
    }
  }
  if (open) {
    open.sessionIds = [...ids].sort();
    conflicts.push(open);
  }
  return conflicts;
}

function detectUnavailable(
  instructorId: string,
  availability: TimeRange[],
  sessions: Session[],
): UnavailableConflict[] {
  const conflicts: UnavailableConflict[] = [];
  for (const s of sessions) {
    let cursor = s.start;
    for (const w of availability) {
      if (w.end <= cursor) continue;
      if (w.start >= s.end) break;
      if (w.start > cursor) {
        conflicts.push({
          kind: "unavailable",
          resourceType: "instructor",
          resourceId: instructorId,
          start: cursor,
          end: Math.min(w.start, s.end),
          sessionIds: [s.id],
        });
      }
      cursor = Math.max(cursor, w.end);
      if (cursor >= s.end) break;
    }
    if (cursor < s.end) {
      conflicts.push({
        kind: "unavailable",
        resourceType: "instructor",
        resourceId: instructorId,
        start: cursor,
        end: s.end,
        sessionIds: [s.id],
      });
    }
  }
  return conflicts;
}

export class SkillPulseScheduler {
  private readonly instructorAvailability = new Map<string, TimeRange[]>();
  private readonly venueCapacity = new Map<string, number>();
  private readonly sessions = new Map<string, Session>();

  constructor(config: ResourceConfig, initialSessions: Session[]) {
    for (const instructor of config.instructors) {
      this.instructorAvailability.set(
        instructor.id,
        mergeWindows(instructor.availability),
      );
    }
    for (const venue of config.venues) {
      this.venueCapacity.set(venue.id, venue.capacity);
    }
    for (const session of initialSessions) {
      validateSession(session);
      if (this.sessions.has(session.id)) {
        throw new Error(`duplicate initial session id: ${session.id}`);
      }
      this.sessions.set(session.id, {
        ...session,
        traineeIds: [...session.traineeIds],
      });
    }
  }

  checkBatch(changes: BatchChange[]): Conflict[] {
    const finalSessions = this.simulate(changes);
    return this.detectConflicts([...finalSessions.values()]);
  }

  applyBatch(changes: BatchChange[]): Conflict[] {
    const finalSessions = this.simulate(changes);
    const conflicts = this.detectConflicts([...finalSessions.values()]);
    if (conflicts.length > 0) {
      return conflicts;
    }
    this.sessions.clear();
    for (const [id, session] of finalSessions) {
      this.sessions.set(id, session);
    }
    return [];
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session, traineeIds: [...session.traineeIds] } : undefined;
  }

  private simulate(changes: BatchChange[]): Map<string, Session> {
    const seen = new Set<string>();
    for (const change of changes) {
      const id = change.type === "remove" ? change.id : change.session.id;
      if (seen.has(id)) {
        throw new Error(`batch contains id ${id} more than once`);
      }
      seen.add(id);
    }
    const result = new Map<string, Session>();
    for (const [id, session] of this.sessions) {
      result.set(id, { ...session, traineeIds: [...session.traineeIds] });
    }
    for (const change of changes) {
      if (change.type === "remove") {
        if (!result.delete(change.id)) {
          throw new Error(`cannot remove unknown session id: ${change.id}`);
        }
        continue;
      }
      validateSession(change.session);
      const exists = result.has(change.session.id);
      if (change.type === "add" && exists) {
        throw new Error(`cannot add existing session id: ${change.session.id}`);
      }
      if (change.type === "replace" && !exists) {
        throw new Error(
          `cannot replace unknown session id: ${change.session.id}`,
        );
      }
      result.set(change.session.id, {
        ...change.session,
        traineeIds: [...change.session.traineeIds],
      });
    }
    return result;
  }

  private detectConflicts(sessions: Session[]): Conflict[] {
    const sorted = [...sessions].sort((a, b) => a.id.localeCompare(b.id));
    const byInstructor = new Map<string, Session[]>();
    const venueUsages = new Map<string, Usage[]>();
    const traineeUsages = new Map<string, Usage[]>();
    for (const session of sorted) {
      if (!this.instructorAvailability.has(session.instructorId)) {
        throw new Error(`unknown instructor: ${session.instructorId}`);
      }
      if (!this.venueCapacity.has(session.venueId)) {
        throw new Error(`unknown venue: ${session.venueId}`);
      }
      const list = byInstructor.get(session.instructorId) ?? [];
      list.push(session);
      byInstructor.set(session.instructorId, list);
      const vu = venueUsages.get(session.venueId) ?? [];
      vu.push({ session, weight: session.traineeIds.length });
      venueUsages.set(session.venueId, vu);
      for (const traineeId of session.traineeIds) {
        const tu = traineeUsages.get(traineeId) ?? [];
        tu.push({ session, weight: 1 });
        traineeUsages.set(traineeId, tu);
      }
    }
    const conflicts: Conflict[] = [];
    for (const [instructorId, list] of byInstructor) {
      conflicts.push(
        ...detectOverbooked(
          "instructor",
          instructorId,
          1,
          list.map((session) => ({ session, weight: 1 })),
        ),
        ...detectUnavailable(
          instructorId,
          this.instructorAvailability.get(instructorId)!,
          list,
        ),
      );
    }
    for (const [venueId, usages] of venueUsages) {
      conflicts.push(
        ...detectOverbooked(
          "venue",
          venueId,
          this.venueCapacity.get(venueId)!,
          usages,
        ),
      );
    }
    for (const [traineeId, usages] of traineeUsages) {
      conflicts.push(...detectOverbooked("trainee", traineeId, 1, usages));
    }
    conflicts.sort(
      (a, b) =>
        a.resourceType.localeCompare(b.resourceType) ||
        a.resourceId.localeCompare(b.resourceId) ||
        a.start - b.start ||
        a.end - b.end ||
        a.kind.localeCompare(b.kind),
    );
    return conflicts;
  }
}
