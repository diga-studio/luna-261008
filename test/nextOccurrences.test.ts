import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrences } from "../src/index.js";
import type { ScheduleRule } from "../src/index.js";

const UTC = Date.UTC;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isos(ms: readonly number[]): string[] {
  return ms.map(iso);
}

test("every15Minutes fires at local 00/15/30/45 past the hour", () => {
  const rule: ScheduleRule = { kind: "every15Minutes", timeZone: "UTC" };
  const after = UTC(2024, 5, 15, 10, 7, 33, 400);
  assert.deepEqual(
    isos(nextOccurrences(rule, after, 4)),
    [
      "2024-06-15T10:15:00.000Z",
      "2024-06-15T10:30:00.000Z",
      "2024-06-15T10:45:00.000Z",
      "2024-06-15T11:00:00.000Z",
    ],
  );
});

test("every15Minutes uses local minutes, not UTC minutes (Lord Howe +10:30)", () => {
  const rule: ScheduleRule = {
    kind: "every15Minutes",
    timeZone: "Australia/Lord_Howe",
  };
  // 2024-04-08: Lord Howe is on AEST = UTC+10:30, so local 10:45 is
  // 00:15Z and local :00/:15/:30/:45 land on UTC :30/:45/:00/:15.
  const after = UTC(2024, 3, 8, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 3)), [
    "2024-04-08T00:15:00.000Z",
    "2024-04-08T00:30:00.000Z",
    "2024-04-08T00:45:00.000Z",
  ]);
});

test("hourly fires at local minute 00", () => {
  const rule: ScheduleRule = { kind: "hourly", timeZone: "Asia/Shanghai" };
  // Asia/Shanghai is UTC+8 with no DST: local 09:00 = 01:00Z.
  const after = UTC(2024, 5, 15, 0, 30);
  assert.deepEqual(isos(nextOccurrences(rule, after, 3)), [
    "2024-06-15T01:00:00.000Z",
    "2024-06-15T02:00:00.000Z",
    "2024-06-15T03:00:00.000Z",
  ]);
});

test("daily follows local calendar across spring forward (UTC shifts by 1h)", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 1,
    minute: 30,
  };
  // The 2024-03-10 spring forward happens at 02:00, so 01:30 on 03-10
  // is still EST (06:30Z); from 03-11 on, 01:30 EDT = 05:30Z.
  const after = UTC(2024, 2, 8, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 4)), [
    "2024-03-08T06:30:00.000Z",
    "2024-03-09T06:30:00.000Z",
    "2024-03-10T06:30:00.000Z",
    "2024-03-11T05:30:00.000Z",
  ]);
});

test("daily skips a local time that does not exist (New York spring gap)", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 2,
    minute: 30,
  };
  // 2024-03-10 02:30 never happens in New York (02:00 -> 03:00); it must
  // be skipped, not shifted to 03:30.
  const after = UTC(2024, 2, 9, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 3)), [
    "2024-03-09T07:30:00.000Z", // 02:30 EST
    "2024-03-11T06:30:00.000Z", // 02:30 EDT (03-10 skipped)
    "2024-03-12T06:30:00.000Z",
  ]);
});

test("daily fires twice for a repeated local time (New York fall overlap)", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 1,
    minute: 30,
  };
  // 2024-11-03 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST).
  const after = UTC(2024, 10, 2, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 4)), [
    "2024-11-02T05:30:00.000Z",
    "2024-11-03T05:30:00.000Z",
    "2024-11-03T06:30:00.000Z",
    "2024-11-04T06:30:00.000Z",
  ]);
});

test("after between the two repeated 01:30 instants still finds the second", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 1,
    minute: 30,
  };
  // 05:45Z on 2024-11-03 is 01:45 EDT: the first 01:30 is past, the
  // second (06:30Z) is not.
  const after = UTC(2024, 10, 3, 5, 45);
  assert.deepEqual(isos(nextOccurrences(rule, after, 2)), [
    "2024-11-03T06:30:00.000Z",
    "2024-11-04T06:30:00.000Z",
  ]);
});

test("after exactly at the first repeated instant excludes it (strictly after)", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 1,
    minute: 30,
  };
  const after = UTC(2024, 10, 3, 5, 30);
  assert.deepEqual(isos(nextOccurrences(rule, after, 2)), [
    "2024-11-03T06:30:00.000Z",
    "2024-11-04T06:30:00.000Z",
  ]);
});

test("weekly fires on the given local weekday (Mon=1..Sun=7)", () => {
  const rule: ScheduleRule = {
    kind: "weekly",
    timeZone: "UTC",
    weekday: 7, // Sunday
    hour: 8,
    minute: 5,
  };
  // 2024-06-10 is a Monday.
  const after = UTC(2024, 5, 10, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 3)), [
    "2024-06-16T08:05:00.000Z",
    "2024-06-23T08:05:00.000Z",
    "2024-06-30T08:05:00.000Z",
  ]);
});

test("weekly Monday across a DST boundary keeps the local time", () => {
  const rule: ScheduleRule = {
    kind: "weekly",
    timeZone: "America/New_York",
    weekday: 1, // Monday
    hour: 9,
    minute: 0,
  };
  const after = UTC(2024, 2, 4, 0, 0); // Monday 2024-03-04
  assert.deepEqual(isos(nextOccurrences(rule, after, 3)), [
    "2024-03-04T14:00:00.000Z", // 09:00 EST
    "2024-03-11T13:00:00.000Z", // 09:00 EDT
    "2024-03-18T13:00:00.000Z",
  ]);
});

test("Lord Howe half-hour fall-back fires twice, 30 minutes apart", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "Australia/Lord_Howe",
    hour: 1,
    minute: 45,
  };
  // 2024-04-07: clocks fall back 02:00 -> 01:30 (+11 -> +10:30), so
  // 01:45 occurs at 14:45Z and again at 15:15Z (both on 04-06 in UTC).
  const after = UTC(2024, 3, 5, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 4)), [
    "2024-04-05T14:45:00.000Z", // 04-06 01:45 +11
    "2024-04-06T14:45:00.000Z", // 04-07 01:45 +11 (first)
    "2024-04-06T15:15:00.000Z", // 04-07 01:45 +10:30 (second)
    "2024-04-07T15:15:00.000Z", // 04-08 01:45 +10:30
  ]);
});

test("Lord Howe half-hour spring forward skips the nonexistent local time", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "Australia/Lord_Howe",
    hour: 2,
    minute: 15,
  };
  // 2024-10-06: clocks spring forward 02:00 -> 02:30 (+10:30 -> +11);
  // 02:15 never happens.
  const after = UTC(2024, 9, 4, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 3)), [
    "2024-10-04T15:45:00.000Z", // 10-05 02:15 +10:30
    "2024-10-06T15:15:00.000Z", // 10-07 02:15 +11 (10-06 skipped)
    "2024-10-07T15:15:00.000Z",
  ]);
});

test("Apia daily skips 2011-12-30, the day that never existed", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "Pacific/Apia",
    hour: 9,
    minute: 0,
  };
  // Apia jumped from UTC-10 to UTC+14 at the end of 2011-12-29, erasing
  // Friday 2011-12-30 entirely.
  const after = UTC(2011, 11, 28, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 4)), [
    "2011-12-28T19:00:00.000Z", // 12-28 09:00 -10
    "2011-12-29T19:00:00.000Z", // 12-29 09:00 -10
    "2011-12-30T19:00:00.000Z", // 12-31 09:00 +14 (12-30 skipped)
    "2011-12-31T19:00:00.000Z", // 01-01 09:00 +14
  ]);
});

test("Apia weekly Friday skips 2011-12-30", () => {
  const rule: ScheduleRule = {
    kind: "weekly",
    timeZone: "Pacific/Apia",
    weekday: 5, // Friday
    hour: 9,
    minute: 0,
  };
  const after = UTC(2011, 11, 22, 0, 0);
  assert.deepEqual(isos(nextOccurrences(rule, after, 3)), [
    "2011-12-23T19:00:00.000Z", // Friday 12-23 09:00 -10
    "2012-01-05T19:00:00.000Z", // Friday 01-06 09:00 +14 (12-30 skipped)
    "2012-01-12T19:00:00.000Z",
  ]);
});

test("all trigger instants have zero seconds and milliseconds", () => {
  const rules: ScheduleRule[] = [
    { kind: "every15Minutes", timeZone: "America/New_York" },
    { kind: "hourly", timeZone: "Australia/Lord_Howe" },
    { kind: "daily", timeZone: "Pacific/Apia", hour: 3, minute: 7 },
    { kind: "weekly", timeZone: "America/New_York", weekday: 3, hour: 23, minute: 59 },
  ];
  for (const rule of rules) {
    for (const at of nextOccurrences(rule, UTC(2024, 0, 1), 20)) {
      assert.equal(at % 60000, 0, `${iso(at)} has nonzero seconds/ms`);
    }
  }
});

test("limit 0 yields an empty array; invalid inputs throw", () => {
  const rule: ScheduleRule = { kind: "hourly", timeZone: "UTC" };
  assert.deepEqual(nextOccurrences(rule, 0, 0), []);
  assert.throws(() => nextOccurrences(rule, 0, -1));
  assert.throws(() =>
    nextOccurrences({ kind: "daily", timeZone: "UTC", hour: 24, minute: 0 }, 0, 1),
  );
  assert.throws(() =>
    nextOccurrences(
      { kind: "weekly", timeZone: "UTC", weekday: 8, hour: 0, minute: 0 },
      0,
      1,
    ),
  );
  assert.throws(() =>
    nextOccurrences({ kind: "hourly", timeZone: "Not/AZone" }, 0, 1),
  );
});
