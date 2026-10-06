import assert from "node:assert/strict";
import test from "node:test";
import { nextOccurrences } from "../src/index.js";
import type { ScheduleRule } from "../src/index.js";

const utc = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();
const isoAll = (times: number[]): string[] => times.map(iso);

test("every-15-minutes fires at local 00/15/30/45, strictly after", () => {
  const rule: ScheduleRule = { kind: "every-15-minutes", timeZone: "UTC" };
  const times = nextOccurrences(rule, utc("2024-01-01T00:00:00Z"), 5);
  assert.deepEqual(isoAll(times), [
    "2024-01-01T00:15:00.000Z",
    "2024-01-01T00:30:00.000Z",
    "2024-01-01T00:45:00.000Z",
    "2024-01-01T01:00:00.000Z",
    "2024-01-01T01:15:00.000Z",
  ]);
});

test("every-15-minutes follows local minutes in a non-integral-hour zone", () => {
  // Asia/Kathmandu is UTC+05:45; local 10:00 is 04:15 UTC.
  const rule: ScheduleRule = { kind: "every-15-minutes", timeZone: "Asia/Kathmandu" };
  const times = nextOccurrences(rule, utc("2024-01-01T04:00:00Z"), 3);
  assert.deepEqual(isoAll(times), [
    "2024-01-01T04:15:00.000Z",
    "2024-01-01T04:30:00.000Z",
    "2024-01-01T04:45:00.000Z",
  ]);
});

test("hourly fires at local minute 00", () => {
  const rule: ScheduleRule = { kind: "hourly", timeZone: "UTC" };
  const times = nextOccurrences(rule, utc("2024-01-01T00:30:00Z"), 3);
  assert.deepEqual(isoAll(times), [
    "2024-01-01T01:00:00.000Z",
    "2024-01-01T02:00:00.000Z",
    "2024-01-01T03:00:00.000Z",
  ]);
});

test("daily fires at the given local hour/minute", () => {
  const rule: ScheduleRule = { kind: "daily", timeZone: "UTC", hour: 6, minute: 30 };
  const times = nextOccurrences(rule, utc("2024-01-01T00:00:00Z"), 2);
  assert.deepEqual(isoAll(times), [
    "2024-01-01T06:30:00.000Z",
    "2024-01-02T06:30:00.000Z",
  ]);
});

test("weekly uses Monday=1 .. Sunday=7 local weekdays", () => {
  // 2024-11-03 is a Sunday.
  const sunday: ScheduleRule = {
    kind: "weekly",
    timeZone: "UTC",
    weekday: 7,
    hour: 0,
    minute: 0,
  };
  assert.deepEqual(isoAll(nextOccurrences(sunday, utc("2024-11-01T00:00:00Z"), 2)), [
    "2024-11-03T00:00:00.000Z",
    "2024-11-10T00:00:00.000Z",
  ]);
  // 2024-11-04 is a Monday.
  const monday: ScheduleRule = {
    kind: "weekly",
    timeZone: "America/New_York",
    weekday: 1,
    hour: 9,
    minute: 0,
  };
  assert.deepEqual(isoAll(nextOccurrences(monday, utc("2024-11-01T00:00:00Z"), 2)), [
    "2024-11-04T14:00:00.000Z",
    "2024-11-11T14:00:00.000Z",
  ]);
});

test("America/New_York 2024 spring forward: missing 02:30 is skipped, not shifted", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 2,
    minute: 30,
  };
  // 2024-03-10 02:30 local never happens (EST -> EDT at 02:00).
  const times = nextOccurrences(rule, utc("2024-03-09T00:00:00Z"), 3);
  assert.deepEqual(isoAll(times), [
    "2024-03-09T07:30:00.000Z", // Mar  9 02:30 EST (UTC-5)
    "2024-03-11T06:30:00.000Z", // Mar 11 02:30 EDT (UTC-4); Mar 10 skipped
    "2024-03-12T06:30:00.000Z",
  ]);
});

test("America/New_York 2024 fall back: 01:30 fires twice", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 1,
    minute: 30,
  };
  const times = nextOccurrences(rule, utc("2024-11-02T00:00:00Z"), 4);
  assert.deepEqual(isoAll(times), [
    "2024-11-02T05:30:00.000Z", // Nov 2 01:30 EDT (UTC-4)
    "2024-11-03T05:30:00.000Z", // Nov 3 01:30 EDT (first occurrence)
    "2024-11-03T06:30:00.000Z", // Nov 3 01:30 EST (second occurrence)
    "2024-11-04T06:30:00.000Z", // Nov 4 01:30 EST (UTC-5)
  ]);
});

test("after inside the repeated hour still finds the second 01:30", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "America/New_York",
    hour: 1,
    minute: 30,
  };
  // 06:00 UTC lies between the two 01:30 occurrences (05:30 and 06:30 UTC).
  const times = nextOccurrences(rule, utc("2024-11-03T06:00:00Z"), 2);
  assert.deepEqual(isoAll(times), [
    "2024-11-03T06:30:00.000Z",
    "2024-11-04T06:30:00.000Z",
  ]);
});

test("every-15-minutes across the fall-back fold repeats local quarter hours", () => {
  const rule: ScheduleRule = { kind: "every-15-minutes", timeZone: "America/New_York" };
  const times = nextOccurrences(rule, utc("2024-11-03T05:30:00Z"), 4);
  assert.deepEqual(isoAll(times), [
    "2024-11-03T05:45:00.000Z", // 01:45 EDT
    "2024-11-03T06:30:00.000Z", // 01:30 EST (repeat)
    "2024-11-03T06:45:00.000Z", // 01:45 EST (repeat)
    "2024-11-03T07:00:00.000Z", // 02:00 EST
  ]);
});

test("Australia/Lord_Howe 2024 half-hour fall back: 01:45 fires twice, 30 minutes apart", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "Australia/Lord_Howe",
    hour: 1,
    minute: 45,
  };
  // 2024-04-07: clocks fall back 02:00 +11:00 -> 01:30 +10:30.
  const times = nextOccurrences(rule, utc("2024-04-06T00:00:00Z"), 3);
  assert.deepEqual(isoAll(times), [
    "2024-04-06T14:45:00.000Z", // Apr 7 01:45 +11:00 (first occurrence)
    "2024-04-06T15:15:00.000Z", // Apr 7 01:45 +10:30 (second occurrence)
    "2024-04-07T15:15:00.000Z", // Apr 8 01:45 +10:30
  ]);
});

test("Australia/Lord_Howe 2024 spring forward: 02:15 is skipped", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "Australia/Lord_Howe",
    hour: 2,
    minute: 15,
  };
  // 2024-10-06: clocks jump 02:00 +10:30 -> 02:30 +11:00; 02:00-02:29 missing.
  const times = nextOccurrences(rule, utc("2024-10-04T00:00:00Z"), 3);
  assert.deepEqual(isoAll(times), [
    "2024-10-04T15:45:00.000Z", // Oct 5 02:15 +10:30
    "2024-10-06T15:15:00.000Z", // Oct 7 02:15 +11:00; Oct 6 skipped
    "2024-10-07T15:15:00.000Z", // Oct 8 02:15 +11:00
  ]);
});

test("Pacific/Apia skips 2011-12-30 entirely for a daily schedule", () => {
  const rule: ScheduleRule = {
    kind: "daily",
    timeZone: "Pacific/Apia",
    hour: 12,
    minute: 0,
  };
  // Apia jumped from UTC-10 to UTC+14 across 2011-12-30, which never existed.
  const times = nextOccurrences(rule, utc("2011-12-29T00:00:00Z"), 3);
  assert.deepEqual(isoAll(times), [
    "2011-12-29T22:00:00.000Z", // Dec 29 12:00 -10:00
    "2011-12-30T22:00:00.000Z", // Dec 31 12:00 +14:00; Dec 30 skipped
    "2011-12-31T22:00:00.000Z", // Jan  1 12:00 +14:00
  ]);
});

test("limit 0 returns an empty array", () => {
  const rule: ScheduleRule = { kind: "hourly", timeZone: "UTC" };
  assert.deepEqual(nextOccurrences(rule, utc("2024-01-01T00:00:00Z"), 0), []);
});
