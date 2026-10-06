import type {
  Adjustment,
  BatchResult,
  DateString,
  HistoryRecord,
  PositionId,
} from "./types.js";
import { parseDate, type DayNumber } from "./date.js";
import { PositionTimeline } from "./history.js";

/**
 * In-memory effective-dated org reporting-line planner.
 * Holds the full manager history of a fixed set of positions.
 */
export class OrgPlanner {
  private readonly positions: ReadonlySet<PositionId>;
  private timelines: Map<PositionId, PositionTimeline> | null = null;

  constructor(positionIds: readonly PositionId[]) {
    const unique = new Set(positionIds);
    if (unique.size !== positionIds.length) {
      throw new Error("position ids must be unique");
    }
    this.positions = unique;
  }

  /**
   * Load the initial history. Must be legal (no reporting cycles on any day)
   * and cover all dates for every position. Callable exactly once.
   */
  loadInitialHistory(records: readonly HistoryRecord[]): void {
    if (this.timelines !== null) {
      throw new Error("initial history has already been loaded");
    }
    const grouped = new Map<PositionId, { start: DayNumber; end: DayNumber | null; managerId: PositionId | null }[]>();
    for (const record of records) {
      this.assertKnownPosition(record.positionId, "history record");
      this.assertValidManager(record.positionId, record.managerId, "history record");
      const start = parseDate(record.startDate);
      const end = record.endDate === null ? null : parseDate(record.endDate);
      if (end !== null && end <= start) {
        throw new Error(`history record for "${record.positionId}" has an empty or inverted range`);
      }
      const list = grouped.get(record.positionId) ?? [];
      list.push({ start, end, managerId: record.managerId });
      grouped.set(record.positionId, list);
    }
    const timelines = new Map<PositionId, PositionTimeline>();
    for (const positionId of this.positions) {
      const rows = grouped.get(positionId);
      if (!rows || rows.length === 0) {
        throw new Error(`position "${positionId}" has no initial history`);
      }
      rows.sort((a, b) => a.start - b.start);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!;
        const cur = rows[i]!;
        if (prev.end === null || cur.start < prev.end) {
          throw new Error(`initial history of "${positionId}" has overlapping records`);
        }
        if (cur.start > prev.end) {
          throw new Error(`initial history of "${positionId}" does not cover all dates`);
        }
      }
      if (rows[rows.length - 1]!.end !== null) {
        throw new Error(`initial history of "${positionId}" does not cover the infinite future`);
      }
      // The earliest record is treated as reaching back to the beginning of time.
      const intervals = rows.map((row, i) => ({
        start: i === 0 ? -Infinity : row.start,
        end: row.end,
        managerId: row.managerId,
      }));
      timelines.set(positionId, new PositionTimeline(intervals));
    }
    const cycle = findCycle(timelines);
    if (cycle !== null) {
      throw new Error(`initial history has a reporting cycle: ${cycle.join(" -> ")}`);
    }
    this.timelines = timelines;
  }

  /**
   * Apply a batch of adjustments atomically. The batch is validated against
   * the organization that results from ALL adjustments taking effect
   * together: every day must be free of reporting cycles. An invalid batch
   * is rejected as a whole and leaves existing history untouched.
   */
  applyBatch(adjustments: readonly Adjustment[]): BatchResult {
    const current = this.requireTimelines();
    interface ParsedAdjustment {
      positionId: PositionId;
      managerId: PositionId | null;
      start: DayNumber;
      end: DayNumber | null;
    }
    const parsed: ParsedAdjustment[] = [];
    try {
      for (const adjustment of adjustments) {
        this.assertKnownPosition(adjustment.positionId, "adjustment");
        this.assertValidManager(adjustment.positionId, adjustment.managerId, "adjustment");
        const start = parseDate(adjustment.startDate);
        const end = adjustment.endDate === null ? null : parseDate(adjustment.endDate);
        if (end !== null && end <= start) {
          return { ok: false, reason: `adjustment for "${adjustment.positionId}" has an empty or inverted range` };
        }
        parsed.push({ positionId: adjustment.positionId, managerId: adjustment.managerId, start, end });
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    // Within one batch, the ranges of a single position must not overlap.
    const byPosition = new Map<PositionId, ParsedAdjustment[]>();
    for (const item of parsed) {
      const list = byPosition.get(item.positionId) ?? [];
      list.push(item);
      byPosition.set(item.positionId, list);
    }
    for (const [positionId, list] of byPosition) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const cur = list[i]!;
        if (prev.end === null || cur.start < prev.end) {
          return { ok: false, reason: `batch has overlapping adjustments for "${positionId}"` };
        }
      }
    }
    // Apply the whole batch to a copy; commit only if every day stays acyclic.
    const candidate = new Map<PositionId, PositionTimeline>();
    for (const [positionId, timeline] of current) {
      candidate.set(positionId, timeline.clone());
    }
    for (const item of parsed) {
      const timeline = candidate.get(item.positionId)!;
      candidate.set(item.positionId, timeline.withReplacement(item.start, item.end, item.managerId));
    }
    const cycle = findCycle(candidate);
    if (cycle !== null) {
      return { ok: false, reason: `batch rejected: reporting cycle ${cycle.join(" -> ")}` };
    }
    this.timelines = candidate;
    return { ok: true };
  }

  /** Manager of a position on a given date, or null if it is a top position. */
  getManagerAt(positionId: PositionId, date: DateString): PositionId | null {
    const timelines = this.requireTimelines();
    const timeline = timelines.get(positionId);
    if (!timeline) {
      throw new Error(`unknown position "${positionId}"`);
    }
    return timeline.managerAt(parseDate(date));
  }

  /** Restore the whole organization on a given date: position -> manager. */
  getOrgSnapshot(date: DateString): Record<PositionId, PositionId | null> {
    const timelines = this.requireTimelines();
    const day = parseDate(date);
    const snapshot: Record<PositionId, PositionId | null> = {};
    for (const [positionId, timeline] of timelines) {
      snapshot[positionId] = timeline.managerAt(day);
    }
    return snapshot;
  }

  private requireTimelines(): Map<PositionId, PositionTimeline> {
    if (this.timelines === null) {
      throw new Error("initial history has not been loaded yet");
    }
    return this.timelines;
  }

  private assertKnownPosition(positionId: PositionId, what: string): void {
    if (!this.positions.has(positionId)) {
      throw new Error(`${what} references unknown position "${positionId}"`);
    }
  }

  private assertValidManager(positionId: PositionId, managerId: PositionId | null, what: string): void {
    if (managerId === null) {
      return;
    }
    if (!this.positions.has(managerId)) {
      throw new Error(`${what} references unknown manager position "${managerId}"`);
    }
    if (managerId === positionId) {
      throw new Error(`${what} makes "${positionId}" its own manager`);
    }
  }
}

/**
 * Find a reporting cycle on any day covered by the given timelines.
 * The org graph only changes at interval boundaries, so it is enough to
 * inspect one representative day per constant segment. Returns the cycle
 * as a list of positions, or null when every day is acyclic.
 */
function findCycle(timelines: ReadonlyMap<PositionId, PositionTimeline>): PositionId[] | null {
  const days = new Set<DayNumber>();
  let earliest = Infinity;
  for (const timeline of timelines.values()) {
    for (const start of timeline.intervalStarts()) {
      if (Number.isFinite(start)) {
        days.add(start);
        if (start < earliest) {
          earliest = start;
        }
      }
    }
  }
  if (days.size === 0) {
    days.add(0);
  } else {
    days.add(earliest - 1);
  }
  for (const day of days) {
    const cycle = findCycleOnDay(timelines, day);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

function findCycleOnDay(
  timelines: ReadonlyMap<PositionId, PositionTimeline>,
  day: DayNumber,
): PositionId[] | null {
  const DONE = 2;
  const IN_STACK = 1;
  const state = new Map<PositionId, number>();
  for (const start of timelines.keys()) {
    if (state.get(start) === DONE) {
      continue;
    }
    const path: PositionId[] = [];
    let current: PositionId | null = start;
    while (current !== null) {
      const mark = state.get(current);
      if (mark === DONE) {
        break;
      }
      if (mark === IN_STACK) {
        return [...path.slice(path.indexOf(current)), current];
      }
      state.set(current, IN_STACK);
      path.push(current);
      current = timelines.get(current)!.managerAt(day);
    }
    for (const id of path) {
      state.set(id, DONE);
    }
  }
  return null;
}
