import { occurrencesInWindow } from "./occurrences.js";
import type { DueItem, DuePage, Schedule } from "./types.js";

/** UTF-16 code unit order, matching the spec for scheduleId tie-breaking. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareItems(a: DueItem, b: DueItem): number {
  if (a.time !== b.time) return a.time - b.time;
  return compareIds(a.scheduleId, b.scheduleId);
}

interface CursorPosition {
  time: number;
  scheduleId: string;
}

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.time, position.scheduleId]), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "number" ||
    typeof parsed[1] !== "string"
  ) {
    throw new Error("invalid cursor");
  }
  return { time: parsed[0], scheduleId: parsed[1] };
}

function isAfter(position: CursorPosition | null, item: DueItem): boolean {
  if (position === null) return true;
  if (item.time !== position.time) return item.time > position.time;
  return compareIds(item.scheduleId, position.scheduleId) > 0;
}

/**
 * Pages through all trigger items of `schedules` in the half-open window
 * (fromMs, toMs], ordered by UTC time then scheduleId (UTF-16 code unit
 * order). Omit `cursor` (or pass null) for the first page; `pageSize` may
 * change between calls.
 */
export function pageDue(
  schedules: Schedule[],
  fromMs: number,
  toMs: number,
  pageSize: number,
  cursor?: string | null,
): DuePage {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
  }
  const position = cursor === undefined || cursor === null ? null : decodeCursor(cursor);

  const all: DueItem[] = [];
  for (const schedule of schedules) {
    for (const time of occurrencesInWindow(schedule.rule, fromMs, toMs)) {
      all.push({ scheduleId: schedule.scheduleId, time });
    }
  }
  all.sort(compareItems);

  const items: DueItem[] = [];
  let index = 0;
  while (index < all.length && items.length < pageSize) {
    const item = all[index]!;
    if (isAfter(position, item)) {
      items.push(item);
    }
    index += 1;
  }

  const last = items[items.length - 1];
  const nextCursor = last !== undefined && index < all.length ? encodeCursor(last) : null;
  return { items, nextCursor };
}
