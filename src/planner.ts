import { DayNumber, parseBound, parseDate } from "./dates";
import {
  assertValidTimeline,
  cloneTimeline,
  managerOn,
  replaceRange,
  Timeline,
} from "./history";
import { Adjustment, BatchResult, DateString, HistoryRecord, OrgSnapshot } from "./types";

interface ParsedAdjustment {
  positionId: string;
  manager: string | null;
  start: DayNumber;
  end: DayNumber;
}

/**
 * In-memory effective-dated org planner. The set of positions is fixed
 * at construction; every position has a stable string identifier.
 */
export class OrgPlanner {
  private readonly positions: ReadonlySet<string>;
  private readonly timelines = new Map<string, Timeline>();
  private historyLoaded = false;

  constructor(positionIds: string[]) {
    if (positionIds.length === 0) {
      throw new Error("at least one position is required");
    }
    const seen = new Set<string>();
    for (const id of positionIds) {
      if (seen.has(id)) {
        throw new Error(`duplicate position id "${id}"`);
      }
      seen.add(id);
    }
    this.positions = seen;
  }

  /**
   * Load the initial history. The records of every position must tile
   * the whole timeline exactly once. May only be called once, before
   * any adjustment.
   */
  loadHistory(records: HistoryRecord[]): void {
    if (this.historyLoaded) {
      throw new Error("initial history has already been loaded");
    }
    const grouped = new Map<string, Timeline>();
    for (const id of this.positions) {
      grouped.set(id, []);
    }
    for (const record of records) {
      const timeline = grouped.get(record.positionId);
      if (!timeline) {
        throw new Error(`unknown position "${record.positionId}" in initial history`);
      }
      this.assertManagerReference(record.positionId, record.managerId);
      timeline.push({
        start: parseBound(record.start, -Infinity),
        end: parseBound(record.end, Infinity),
        manager: record.managerId,
      });
    }
    for (const [positionId, timeline] of grouped) {
      timeline.sort((a, b) => a.start - b.start);
      assertValidTimeline(timeline, positionId);
    }
    const cycleDay = this.findCycleDay(grouped);
    if (cycleDay !== null) {
      throw new Error(`initial history contains a reporting cycle (day ${cycleDay})`);
    }
    this.timelines.clear();
    for (const [positionId, timeline] of grouped) {
      this.timelines.set(positionId, timeline);
    }
    this.historyLoaded = true;
  }

  /**
   * Apply a batch of adjustments atomically. Adjustments in one batch
   * have no ordering semantics: validity is judged on the organization
   * after all of them take effect together. The whole batch is
   * rejected (and stored history left untouched) if any adjustment is
   * malformed or the resulting organization contains a reporting
   * cycle on any day, past or future.
   */
  applyBatch(adjustments: Adjustment[]): BatchResult {
    this.assertLoaded();
    let parsed: ParsedAdjustment[];
    try {
      parsed = adjustments.map((adjustment) => this.parseAdjustment(adjustment));
    } catch (error) {
      return { accepted: false, reason: (error as Error).message };
    }
    const overlap = this.findIntraBatchOverlap(parsed);
    if (overlap !== null) {
      return { accepted: false, reason: overlap };
    }

    const candidate = new Map<string, Timeline>();
    for (const [positionId, timeline] of this.timelines) {
      candidate.set(positionId, cloneTimeline(timeline));
    }
    for (const adjustment of parsed) {
      const timeline = candidate.get(adjustment.positionId)!;
      candidate.set(
        adjustment.positionId,
        replaceRange(timeline, adjustment.start, adjustment.end, adjustment.manager)
      );
    }

    const cycleDay = this.findCycleDay(candidate);
    if (cycleDay !== null) {
      return {
        accepted: false,
        reason: `batch rejected: adjustments create a reporting cycle (day ${cycleDay})`,
      };
    }
    this.timelines.clear();
    for (const [positionId, timeline] of candidate) {
      this.timelines.set(positionId, timeline);
    }
    return { accepted: true };
  }

  /** Manager of a position on a given day (null = top-level). */
  getManager(positionId: string, date: DateString): string | null {
    this.assertLoaded();
    const timeline = this.timelines.get(positionId);
    if (!timeline) {
      throw new Error(`unknown position "${positionId}"`);
    }
    return managerOn(timeline, parseDate(date));
  }

  /** Reconstruct the full organization as of a day. */
  getSnapshot(date: DateString): OrgSnapshot {
    this.assertLoaded();
    const day = parseDate(date);
    const snapshot: OrgSnapshot = {};
    for (const [positionId, timeline] of this.timelines) {
      snapshot[positionId] = managerOn(timeline, day);
    }
    return snapshot;
  }

  private assertLoaded(): void {
    if (!this.historyLoaded) {
      throw new Error("initial history must be loaded first");
    }
  }

  private assertManagerReference(positionId: string, managerId: string | null): void {
    if (managerId === null) {
      return;
    }
    if (!this.positions.has(managerId)) {
      throw new Error(`unknown manager position "${managerId}"`);
    }
    if (managerId === positionId) {
      throw new Error(`position "${positionId}" cannot report to itself`);
    }
  }

  private parseAdjustment(adjustment: Adjustment): ParsedAdjustment {
    if (!this.positions.has(adjustment.positionId)) {
      throw new Error(`unknown position "${adjustment.positionId}" in adjustment`);
    }
    this.assertManagerReference(adjustment.positionId, adjustment.newManagerId);
    const start = parseDate(adjustment.start);
    const end = parseBound(adjustment.end, Infinity);
    if (!(start < end)) {
      throw new Error(
        `adjustment of "${adjustment.positionId}" has an empty or inverted interval`
      );
    }
    return {
      positionId: adjustment.positionId,
      manager: adjustment.newManagerId,
      start,
      end,
    };
  }

  private findIntraBatchOverlap(parsed: ParsedAdjustment[]): string | null {
    const byPosition = new Map<string, ParsedAdjustment[]>();
    for (const adjustment of parsed) {
      const list = byPosition.get(adjustment.positionId) ?? [];
      list.push(adjustment);
      byPosition.set(adjustment.positionId, list);
    }
    for (const [positionId, list] of byPosition) {
      list.sort((a, b) => a.start - b.start);
      for (let index = 1; index < list.length; index += 1) {
        if (list[index]!.start < list[index - 1]!.end) {
          return `batch rejected: overlapping adjustments for position "${positionId}"`;
        }
      }
    }
    return null;
  }

  /**
   * Manager assignments only change at segment boundaries, so checking
   * one sample day per atomic interval between consecutive boundaries
   * covers every day from the infinite past to the infinite future.
   * Returns a sample day containing a cycle, or null if none exists.
   */
  private findCycleDay(timelines: Map<string, Timeline>): DayNumber | null {
    const boundaries = new Set<DayNumber>();
    for (const timeline of timelines.values()) {
      for (const segment of timeline) {
        if (Number.isFinite(segment.start)) boundaries.add(segment.start);
        if (Number.isFinite(segment.end)) boundaries.add(segment.end);
      }
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    const samples: DayNumber[] = [];
    if (sorted.length === 0) {
      samples.push(0);
    } else {
      samples.push(sorted[0]! - 1);
      for (const boundary of sorted) {
        samples.push(boundary);
      }
    }
    for (const day of samples) {
      if (this.hasCycleOn(timelines, day)) {
        return day;
      }
    }
    return null;
  }

  private hasCycleOn(timelines: Map<string, Timeline>, day: DayNumber): boolean {
    const managers = new Map<string, string | null>();
    for (const [positionId, timeline] of timelines) {
      managers.set(positionId, managerOn(timeline, day));
    }
    for (const start of managers.keys()) {
      const visited = new Set<string>();
      let current: string | undefined = start;
      while (current !== undefined) {
        if (visited.has(current)) {
          return true;
        }
        visited.add(current);
        const next: string | null | undefined = managers.get(current);
        current = next === null ? undefined : next;
      }
    }
    return false;
  }
}
