import { nextOccurrences } from "./nextOccurrences.js";
import type { DueItem, PageCursor, PageResult, Schedule } from "./types.js";

/**
 * Cursor payload: for each schedule, the UTC instant of its last emitted
 * item (schedules that have emitted nothing yet are absent and restart
 * from the window's `from`). The rule set and window are fixed for the
 * duration of a paginated scan, so resuming only needs these positions.
 */
interface CursorPayload {
  readonly v: 1;
  readonly p: ReadonlyArray<readonly [string, number]>;
}

function encodeCursor(positions: ReadonlyMap<string, number>): PageCursor {
  const payload: CursorPayload = { v: 1, p: [...positions.entries()] };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function decodeCursor(cursor: PageCursor): Map<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw new Error("invalid pageDue cursor");
  }
  const payload = parsed as CursorPayload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    payload.v !== 1 ||
    !Array.isArray(payload.p) ||
    !payload.p.every(
      (e) =>
        Array.isArray(e) &&
        e.length === 2 &&
        typeof e[0] === "string" &&
        typeof e[1] === "number" &&
        Number.isFinite(e[1]),
    )
  ) {
    throw new Error("invalid pageDue cursor");
  }
  return new Map(payload.p);
}

/** UTF-16 code-unit order, which is exactly what `<` does on strings. */
function compareItems(a: DueItem, b: DueItem): number {
  if (a.at !== b.at) {
    return a.at - b.at;
  }
  return a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0;
}

/**
 * One page of due items across all `schedules` in the half-open window
 * (from, to] (UTC ms), ordered by (at, scheduleId UTF-16 code units).
 *
 * Omit `cursor` for the first page; feed back `nextCursor` for subsequent
 * pages. Concatenating all pages yields every occurrence in the window
 * exactly once, in order; simultaneous occurrences of different schedules
 * are all kept, even across page boundaries. `pageSize` may differ
 * between calls.
 */
export function pageDue(
  schedules: readonly Schedule[],
  from: number,
  to: number,
  pageSize: number,
  cursor?: PageCursor,
): PageResult {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`invalid pageSize: ${pageSize}`);
  }
  const positions =
    cursor === undefined ? new Map<string, number>() : decodeCursor(cursor);

  interface Head {
    readonly schedule: Schedule;
    next: number | undefined; // next candidate instant, undefined when exhausted
  }
  const heads: Head[] = schedules.map((schedule) => {
    const after = positions.get(schedule.scheduleId) ?? from;
    const [next] = nextOccurrences(schedule.rule, after, 1);
    return { schedule, next: next !== undefined && next <= to ? next : undefined };
  });

  const items: DueItem[] = [];
  while (items.length < pageSize) {
    let best: Head | undefined;
    let bestItem: DueItem | undefined;
    for (const head of heads) {
      if (head.next === undefined) {
        continue;
      }
      const item: DueItem = {
        scheduleId: head.schedule.scheduleId,
        at: head.next,
      };
      if (bestItem === undefined || compareItems(item, bestItem) < 0) {
        best = head;
        bestItem = item;
      }
    }
    if (best === undefined || bestItem === undefined) {
      break;
    }
    items.push(bestItem);
    positions.set(best.schedule.scheduleId, bestItem.at);
    const [next] = nextOccurrences(best.schedule.rule, bestItem.at, 1);
    best.next = next !== undefined && next <= to ? next : undefined;
  }

  const hasMore = heads.some((head) => head.next !== undefined);
  const result: PageResult = { items };
  if (hasMore) {
    return { items, nextCursor: encodeCursor(positions) };
  }
  return result;
}
