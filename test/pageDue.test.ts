import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrences, pageDue } from "../src/index.js";
import type { DueItem, Schedule } from "../src/index.js";

const UTC = Date.UTC;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function render(items: readonly DueItem[]): string[] {
  return items.map((item) => `${iso(item.at)} ${item.scheduleId}`);
}

/** Drain all pages, allowing a different pageSize per page. */
function drain(
  schedules: readonly Schedule[],
  from: number,
  to: number,
  pageSizes: readonly number[],
): { items: DueItem[]; pageCounts: number[] } {
  const items: DueItem[] = [];
  const pageCounts: number[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    const pageSize = pageSizes[Math.min(page, pageSizes.length - 1)]!;
    const result = pageDue(schedules, from, to, pageSize, cursor);
    items.push(...result.items);
    pageCounts.push(result.items.length);
    if (result.nextCursor === undefined) {
      return { items, pageCounts };
    }
    cursor = result.nextCursor;
    assert.ok(page < 1000, "pagination did not terminate");
  }
}

test("window is (from, to]: from excluded, to included", () => {
  const schedules: Schedule[] = [
    { scheduleId: "hourly", rule: { kind: "hourly", timeZone: "UTC" } },
  ];
  const from = UTC(2024, 5, 15, 0, 0);
  const to = UTC(2024, 5, 15, 3, 0);
  const { items } = drain(schedules, from, to, [10]);
  assert.deepEqual(render(items), [
    "2024-06-15T01:00:00.000Z hourly",
    "2024-06-15T02:00:00.000Z hourly",
    "2024-06-15T03:00:00.000Z hourly",
  ]);
});

test("ordering: UTC instant first, then scheduleId in UTF-16 code-unit order", () => {
  const schedules: Schedule[] = [
    { scheduleId: "beta", rule: { kind: "hourly", timeZone: "UTC" } },
    {
      scheduleId: "alpha",
      rule: { kind: "daily", timeZone: "UTC", hour: 2, minute: 0 },
    },
    {
      scheduleId: "Alpha",
      rule: { kind: "daily", timeZone: "UTC", hour: 2, minute: 0 },
    },
  ];
  const from = UTC(2024, 5, 15, 0, 0);
  const to = UTC(2024, 5, 15, 3, 0);
  // UTF-16: "Alpha" (A=0x41) < "alpha" (a=0x61) < "beta" (b=0x62).
  const { items } = drain(schedules, from, to, [100]);
  assert.deepEqual(render(items), [
    "2024-06-15T01:00:00.000Z beta",
    "2024-06-15T02:00:00.000Z Alpha",
    "2024-06-15T02:00:00.000Z alpha",
    "2024-06-15T02:00:00.000Z beta",
    "2024-06-15T03:00:00.000Z beta",
  ]);
});

test("simultaneous occurrences all survive pageSize 1 page boundaries", () => {
  const schedules: Schedule[] = [
    {
      scheduleId: "Alpha",
      rule: { kind: "daily", timeZone: "UTC", hour: 2, minute: 0 },
    },
    {
      scheduleId: "alpha",
      rule: { kind: "daily", timeZone: "UTC", hour: 2, minute: 0 },
    },
    {
      scheduleId: "beta",
      rule: { kind: "daily", timeZone: "UTC", hour: 2, minute: 0 },
    },
  ];
  const from = UTC(2024, 5, 15, 0, 0);
  const to = UTC(2024, 5, 15, 3, 0);
  const { items, pageCounts } = drain(schedules, from, to, [1]);
  assert.deepEqual(pageCounts, [1, 1, 1]);
  assert.deepEqual(render(items), [
    "2024-06-15T02:00:00.000Z Alpha",
    "2024-06-15T02:00:00.000Z alpha",
    "2024-06-15T02:00:00.000Z beta",
  ]);
});

test("page boundary between the two repeated 01:30 instants keeps both", () => {
  const schedules: Schedule[] = [
    {
      scheduleId: "ny-daily",
      rule: {
        kind: "daily",
        timeZone: "America/New_York",
        hour: 1,
        minute: 30,
      },
    },
    { scheduleId: "ny-hourly", rule: { kind: "hourly", timeZone: "America/New_York" } },
  ];
  // 2024-11-03: New York falls back; 01:30 occurs at 05:30Z and 06:30Z.
  const from = UTC(2024, 10, 3, 4, 0);
  const to = UTC(2024, 10, 3, 8, 0);
  const expected = [
    "2024-11-03T05:00:00.000Z ny-hourly", // 01:00 EDT
    "2024-11-03T05:30:00.000Z ny-daily", // 01:30 EDT (first)
    "2024-11-03T06:00:00.000Z ny-hourly", // 01:00 EST
    "2024-11-03T06:30:00.000Z ny-daily", // 01:30 EST (second)
    "2024-11-03T07:00:00.000Z ny-hourly",
    "2024-11-03T08:00:00.000Z ny-hourly",
  ];
  // pageSize 2 puts the page boundary exactly between the two 01:30
  // occurrences (05:30Z ends page 1, 06:30Z is on page 2).
  const { items, pageCounts } = drain(schedules, from, to, [2]);
  assert.deepEqual(pageCounts, [2, 2, 2]);
  assert.deepEqual(render(items), expected);
  // Any other page size must yield the identical concatenation.
  for (const size of [1, 3, 4, 5, 6, 7]) {
    assert.deepEqual(render(drain(schedules, from, to, [size]).items), expected);
  }
});

test("concatenated pages equal the independent full-window merge, pageSize may vary", () => {
  const schedules: Schedule[] = [
    { scheduleId: "c-q15", rule: { kind: "every15Minutes", timeZone: "UTC" } },
    { scheduleId: "b-hourly", rule: { kind: "hourly", timeZone: "America/New_York" } },
    {
      scheduleId: "a-daily",
      rule: {
        kind: "daily",
        timeZone: "America/New_York",
        hour: 1,
        minute: 30,
      },
    },
  ];
  const from = UTC(2024, 10, 3, 3, 0);
  const to = UTC(2024, 10, 3, 9, 0);

  // Independent reference: merge each schedule's own occurrence stream.
  const reference: DueItem[] = [];
  for (const schedule of schedules) {
    let after = from;
    for (;;) {
      const [next] = nextOccurrences(schedule.rule, after, 1);
      if (next === undefined || next > to) {
        break;
      }
      reference.push({ scheduleId: schedule.scheduleId, at: next });
      after = next;
    }
  }
  reference.sort((a, b) =>
    a.at !== b.at ? a.at - b.at : a.scheduleId < b.scheduleId ? -1 : 1,
  );
  assert.equal(reference.length, 32);

  for (const sizes of [[1], [2], [5], [32], [100], [3, 7, 2, 9, 1, 4]]) {
    const { items } = drain(schedules, from, to, sizes);
    assert.deepEqual(items, reference, `pageSizes ${sizes.join(",")}`);
  }
});

test("Lord Howe half-hour overlap: both 01:45 instants paginated separately", () => {
  const schedules: Schedule[] = [
    {
      scheduleId: "lh",
      rule: {
        kind: "daily",
        timeZone: "Australia/Lord_Howe",
        hour: 1,
        minute: 45,
      },
    },
  ];
  const from = UTC(2024, 3, 6, 14, 0);
  const to = UTC(2024, 3, 6, 16, 0);
  const { items, pageCounts } = drain(schedules, from, to, [1]);
  assert.deepEqual(pageCounts, [1, 1]);
  assert.deepEqual(render(items), [
    "2024-04-06T14:45:00.000Z lh", // 04-07 01:45 +11 (first)
    "2024-04-06T15:15:00.000Z lh", // 04-07 01:45 +10:30 (second)
  ]);
});

test("Apia skipped day contributes nothing to the window", () => {
  const schedules: Schedule[] = [
    {
      scheduleId: "apia",
      rule: { kind: "daily", timeZone: "Pacific/Apia", hour: 9, minute: 0 },
    },
  ];
  const from = UTC(2011, 11, 28, 0, 0);
  const to = UTC(2012, 0, 2, 0, 0);
  const { items } = drain(schedules, from, to, [2]);
  assert.deepEqual(render(items), [
    "2011-12-28T19:00:00.000Z apia", // 12-28 09:00 -10
    "2011-12-29T19:00:00.000Z apia", // 12-29 09:00 -10
    "2011-12-30T19:00:00.000Z apia", // 12-31 09:00 +14 (12-30 never existed)
    "2011-12-31T19:00:00.000Z apia", // 01-01 09:00 +14
    "2012-01-01T19:00:00.000Z apia", // 01-02 09:00 +14
  ]);
});

test("edge cases: empty schedule list, empty window, invalid arguments", () => {
  const from = UTC(2024, 5, 15, 0, 0);
  const to = UTC(2024, 5, 16, 0, 0);
  assert.deepEqual(pageDue([], from, to, 10), { items: [] });

  const schedules: Schedule[] = [
    {
      scheduleId: "daily",
      rule: { kind: "daily", timeZone: "UTC", hour: 12, minute: 0 },
    },
  ];
  // Window between two consecutive triggers contains nothing.
  assert.deepEqual(pageDue(schedules, UTC(2024, 5, 15, 12, 0), UTC(2024, 5, 16, 11, 59), 10), {
    items: [],
  });
  // from >= to: empty.
  assert.deepEqual(pageDue(schedules, to, from, 10), { items: [] });

  assert.throws(() => pageDue(schedules, from, to, 0));
  assert.throws(() => pageDue(schedules, from, to, -3));
  assert.throws(() => pageDue(schedules, from, to, 10, "not-a-cursor"));
});

test("cursor chains exactly: last page carries no nextCursor", () => {
  const schedules: Schedule[] = [
    { scheduleId: "q15", rule: { kind: "every15Minutes", timeZone: "UTC" } },
  ];
  const from = UTC(2024, 5, 15, 0, 0);
  const to = UTC(2024, 5, 15, 1, 0);
  const page1 = pageDue(schedules, from, to, 3);
  assert.equal(page1.items.length, 3);
  assert.ok(page1.nextCursor !== undefined);
  const page2 = pageDue(schedules, from, to, 3, page1.nextCursor);
  assert.deepEqual(render(page2.items), ["2024-06-15T01:00:00.000Z q15"]);
  assert.equal(page2.nextCursor, undefined);
});
