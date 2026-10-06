import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, localToUtc, utcToLocal } from "../src/timezone.js";

const t = (iso: string): number => Date.parse(iso);

test("timezone: unique local time converts with the right offset", () => {
  // Summer (EDT, UTC-4) and winter (EST, UTC-5).
  assert.equal(
    localToUtc("2025-06-10", "09:00").utcMs,
    t("2025-06-10T13:00:00.000Z")
  );
  assert.equal(
    localToUtc("2025-01-15", "09:00").utcMs,
    t("2025-01-15T14:00:00.000Z")
  );
});

test("timezone: spring-forward gap shifts forward by the missing hour", () => {
  const r = localToUtc("2025-03-09", "02:30");
  assert.equal(r.kind, "gap");
  assert.equal(r.utcMs, t("2025-03-09T07:30:00.000Z")); // 03:30 EDT
  assert.deepEqual(utcToLocal(r.utcMs), { date: "2025-03-09", time: "03:30" });
});

test("timezone: fall-back repeated time is ambiguous, earlier instant first", () => {
  const r = localToUtc("2025-11-02", "01:30");
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.utcMs, t("2025-11-02T05:30:00.000Z")); // 01:30 EDT
  // The second occurrence is exactly one hour later (01:30 EST).
  assert.deepEqual(utcToLocal(r.utcMs + 3_600_000), {
    date: "2025-11-02",
    time: "01:30",
  });
});

test("timezone: utcToLocal around the fall-back transition", () => {
  assert.deepEqual(utcToLocal(t("2025-11-02T05:59:59.999Z")), {
    date: "2025-11-02",
    time: "01:59",
  });
  assert.deepEqual(utcToLocal(t("2025-11-02T06:00:00.000Z")), {
    date: "2025-11-02",
    time: "01:00",
  });
});

test("timezone: addDays uses calendar arithmetic", () => {
  assert.equal(addDays("2025-03-09", 1), "2025-03-10");
  assert.equal(addDays("2025-11-02", -1), "2025-11-01");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
});
