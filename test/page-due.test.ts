import assert from "node:assert/strict";
import test from "node:test";
import { pageDue } from "../src/index.js";
import type { DueItem, Schedule } from "../src/index.js";

const utc = (iso: string): number => Date.parse(iso);

/** Renders items compactly for exact deep-equal assertions. */
const render = (items: DueItem[]): string[] =>
  items.map((item) => `${item.scheduleId}@${new Date(item.time).toISOString()}`);

/** Drains all pages, switching pageSize per page as given (last one repeats). */
function collectAll(
  schedules: Schedule[],
  from: number,
  to: number,
  pageSizes: number[],
): DueItem[] {
  const all: DueItem[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const size = pageSizes[Math.min(page, pageSizes.length - 1)]!;
    const result = pageDue(schedules, from, to, size, cursor);
    all.push(...result.items);
    cursor = result.nextCursor;
    page += 1;
    assert.ok(page < 100, "pagination did not terminate");
  } while (cursor !== null);
  return all;
}

test("window is left-open and right-closed", () => {
  const schedules: Schedule[] = [
    { scheduleId: "s", rule: { kind: "daily", timeZone: "UTC", hour: 12, minute: 0 } },
  ];
  const page = pageDue(schedules, utc("2024-01-01T12:00:00Z"), utc("2024-01-03T12:00:00Z"), 10);
  assert.deepEqual(render(page.items), [
    "s@2024-01-02T12:00:00.000Z",
    "s@2024-01-03T12:00:00.000Z",
  ]);
  assert.equal(page.nextCursor, null);
});

test("ties on the same instant order by scheduleId in UTF-16 code unit order", () => {
  const schedules: Schedule[] = ["aa", "a", "B"].map((id) => ({
    scheduleId: id,
    rule: { kind: "daily", timeZone: "UTC", hour: 12, minute: 0 } as const,
  }));
  const page = pageDue(schedules, utc("2024-01-01T00:00:00Z"), utc("2024-01-02T00:00:00Z"), 10);
  // 'B' (U+0042) < 'a' (U+0061) < 'aa'.
  assert.deepEqual(render(page.items), [
    "B@2024-01-01T12:00:00.000Z",
    "a@2024-01-01T12:00:00.000Z",
    "aa@2024-01-01T12:00:00.000Z",
  ]);
});

test("fall-back fold: page boundary between the two 01:30 occurrences keeps every item", () => {
  const schedules: Schedule[] = ["a", "b"].map((id) => ({
    scheduleId: id,
    rule: {
      kind: "daily",
      timeZone: "America/New_York",
      hour: 1,
      minute: 30,
    } as const,
  }));
  const from = utc("2024-11-03T00:00:00Z");
  const to = utc("2024-11-04T00:00:00Z");

  const first = pageDue(schedules, from, to, 3);
  assert.deepEqual(render(first.items), [
    "a@2024-11-03T05:30:00.000Z",
    "b@2024-11-03T05:30:00.000Z",
    "a@2024-11-03T06:30:00.000Z",
  ]);
  assert.notEqual(first.nextCursor, null);

  const second = pageDue(schedules, from, to, 3, first.nextCursor);
  assert.deepEqual(render(second.items), ["b@2024-11-03T06:30:00.000Z"]);
  assert.equal(second.nextCursor, null);
});

test("pages concatenate to exactly the full window listing, for any pageSize pattern", () => {
  const schedules: Schedule[] = [
    { scheduleId: "s1", rule: { kind: "every-15-minutes", timeZone: "UTC" } },
    { scheduleId: "s2", rule: { kind: "hourly", timeZone: "UTC" } },
    { scheduleId: "s3", rule: { kind: "daily", timeZone: "UTC", hour: 0, minute: 30 } },
  ];
  const from = utc("2024-01-01T00:00:00Z");
  const to = utc("2024-01-01T01:00:00Z");
  const expected = [
    "s1@2024-01-01T00:15:00.000Z",
    "s1@2024-01-01T00:30:00.000Z",
    "s3@2024-01-01T00:30:00.000Z",
    "s1@2024-01-01T00:45:00.000Z",
    "s1@2024-01-01T01:00:00.000Z",
    "s2@2024-01-01T01:00:00.000Z",
  ];

  for (const sizes of [[1], [2], [3], [6], [100], [2, 1, 4, 3], [5, 2, 1]]) {
    assert.deepEqual(render(collectAll(schedules, from, to, sizes)), expected);
  }
});

test("same-instant duplicates across schedules are all preserved", () => {
  const schedules: Schedule[] = ["x", "y", "z"].map((id) => ({
    scheduleId: id,
    rule: { kind: "hourly", timeZone: "UTC" } as const,
  }));
  const items = collectAll(schedules, utc("2024-01-01T00:00:00Z"), utc("2024-01-01T01:00:00Z"), [2]);
  assert.deepEqual(render(items), [
    "x@2024-01-01T01:00:00.000Z",
    "y@2024-01-01T01:00:00.000Z",
    "z@2024-01-01T01:00:00.000Z",
  ]);
});

test("empty window yields one empty page with null cursor", () => {
  const schedules: Schedule[] = [
    { scheduleId: "s", rule: { kind: "daily", timeZone: "UTC", hour: 12, minute: 0 } },
  ];
  const page = pageDue(schedules, utc("2024-01-02T00:00:00Z"), utc("2024-01-02T01:00:00Z"), 10);
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
});

test("Lord_Howe fold: both half-hour-apart instants appear in paged output", () => {
  const schedules: Schedule[] = [
    {
      scheduleId: "lh",
      rule: { kind: "daily", timeZone: "Australia/Lord_Howe", hour: 1, minute: 45 },
    },
  ];
  const items = collectAll(schedules, utc("2024-04-06T00:00:00Z"), utc("2024-04-07T00:00:00Z"), [1]);
  assert.deepEqual(render(items), [
    "lh@2024-04-06T14:45:00.000Z",
    "lh@2024-04-06T15:15:00.000Z",
  ]);
});
