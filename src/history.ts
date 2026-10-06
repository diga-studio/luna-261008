import type { DayNumber } from "./date.js";
import type { PositionId } from "./types.js";

/** Half-open day interval [start, end); end === null means infinite future. */
export interface Interval {
  start: DayNumber;
  end: DayNumber | null;
  managerId: PositionId | null;
}

/**
 * Effective-dated manager history of one position: a sorted, non-overlapping
 * list of intervals covering all days.
 */
export class PositionTimeline {
  private readonly intervals: Interval[];

  constructor(intervals: Interval[]) {
    if (intervals.length === 0) {
      throw new Error("timeline must contain at least one interval");
    }
    this.intervals = intervals.map((iv) => ({ ...iv }));
  }

  clone(): PositionTimeline {
    return new PositionTimeline(this.intervals);
  }

  /** Manager in effect on the given day. */
  managerAt(day: DayNumber): PositionId | null {
    let lo = 0;
    let hi = this.intervals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const iv = this.intervals[mid]!;
      if (day < iv.start) {
        hi = mid - 1;
      } else if (iv.end !== null && day >= iv.end) {
        lo = mid + 1;
      } else {
        return iv.managerId;
      }
    }
    throw new Error(`no interval covers day ${day}`);
  }

  /** Finite start days of all intervals, ascending. */
  intervalStarts(): DayNumber[] {
    return this.intervals.map((iv) => iv.start);
  }

  /** New timeline with the manager replaced over [start, end). */
  withReplacement(
    start: DayNumber,
    end: DayNumber | null,
    managerId: PositionId | null,
  ): PositionTimeline {
    return new PositionTimeline(replaceRange(this.intervals, start, end, managerId));
  }
}

/** Replace the manager over [start, end), preserving history outside. */
export function replaceRange(
  intervals: Interval[],
  start: DayNumber,
  end: DayNumber | null,
  managerId: PositionId | null,
): Interval[] {
  if (end !== null && end <= start) {
    throw new Error("adjustment range is empty or inverted");
  }
  const pieces: Interval[] = [];
  for (const iv of intervals) {
    const overlaps =
      (iv.end === null || iv.end > start) && (end === null || iv.start < end);
    if (!overlaps) {
      pieces.push(iv);
      continue;
    }
    if (iv.start < start) {
      pieces.push({ start: iv.start, end: start, managerId: iv.managerId });
    }
    if (end !== null && (iv.end === null || iv.end > end)) {
      pieces.push({ start: end, end: iv.end, managerId: iv.managerId });
    }
  }
  pieces.push({ start, end, managerId });
  pieces.sort((a, b) => a.start - b.start);
  return mergeAdjacent(pieces);
}

/** Merge neighbouring intervals that carry the same manager. */
function mergeAdjacent(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && last.managerId === iv.managerId && last.end === iv.start) {
      last.end = iv.end;
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}
