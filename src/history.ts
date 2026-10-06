import { DayNumber } from "./dates";

/**
 * A half-open interval [start, end) during which a position reports
 * to `manager` (null = no manager). Bounds are day serial numbers;
 * -Infinity / +Infinity represent unbounded past / future.
 */
export interface Segment {
  start: DayNumber;
  end: DayNumber;
  manager: string | null;
}

/**
 * Timeline of one position: sorted, contiguous, non-overlapping
 * segments that together cover every day from -Infinity to +Infinity.
 */
export type Timeline = Segment[];

/** Deep-copy a timeline. */
export function cloneTimeline(timeline: Timeline): Timeline {
  return timeline.map((segment) => ({ ...segment }));
}

/**
 * Return a new timeline where the manager on [start, end) is replaced
 * by `manager`. History outside the interval is preserved exactly;
 * adjacent segments with the same manager are merged.
 */
export function replaceRange(
  timeline: Timeline,
  start: DayNumber,
  end: DayNumber,
  manager: string | null
): Timeline {
  const kept: Segment[] = [];
  for (const segment of timeline) {
    if (segment.end <= start || segment.start >= end) {
      kept.push({ ...segment });
      continue;
    }
    if (segment.start < start) {
      kept.push({ start: segment.start, end: start, manager: segment.manager });
    }
    if (segment.end > end) {
      kept.push({ start: end, end: segment.end, manager: segment.manager });
    }
  }
  kept.push({ start, end, manager });
  kept.sort((a, b) => a.start - b.start);

  const merged: Segment[] = [];
  for (const segment of kept) {
    const last = merged[merged.length - 1];
    if (last && last.manager === segment.manager && last.end === segment.start) {
      last.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/** Manager of the position on the given day. */
export function managerOn(timeline: Timeline, day: DayNumber): string | null {
  for (const segment of timeline) {
    if (day >= segment.start && day < segment.end) {
      return segment.manager;
    }
  }
  throw new Error(`timeline does not cover day ${day}`);
}

/**
 * Validate that segments are sorted, non-empty, contiguous and cover
 * every day from -Infinity to +Infinity. Throws on any violation.
 */
export function assertValidTimeline(timeline: Timeline, positionId: string): void {
  if (timeline.length === 0) {
    throw new Error(`history of "${positionId}" is empty`);
  }
  let previousEnd = -Infinity;
  for (const segment of timeline) {
    if (!(segment.start < segment.end)) {
      throw new Error(`history of "${positionId}" has an empty or inverted interval`);
    }
    if (segment.start !== previousEnd) {
      throw new Error(
        `history of "${positionId}" must cover every day exactly once (gap or overlap)`
      );
    }
    previousEnd = segment.end;
  }
  if (previousEnd !== Infinity) {
    throw new Error(`history of "${positionId}" does not extend to the infinite future`);
  }
}
