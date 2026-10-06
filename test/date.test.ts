import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDate, nextDay } from "../src/date.js";

test("parses MM/DD/YYYY and orders by day", () => {
  assert.ok(parseDate("01/01/2025") < parseDate("01/02/2025"));
  assert.ok(parseDate("12/31/2024") < parseDate("01/01/2025"));
  assert.ok(parseDate("02/28/2024") < parseDate("02/29/2024"));
});

test("nextDay crosses month and year boundaries", () => {
  assert.equal(nextDay(parseDate("12/31/2024")), parseDate("01/01/2025"));
  assert.equal(nextDay(parseDate("02/28/2024")), parseDate("02/29/2024"));
  assert.equal(nextDay(parseDate("02/28/2025")), parseDate("03/01/2025"));
});

test("rejects malformed or impossible dates", () => {
  assert.throws(() => parseDate("2025-01-01"));
  assert.throws(() => parseDate("13/01/2025"));
  assert.throws(() => parseDate("02/29/2025"));
  assert.throws(() => parseDate("02/30/2024"));
  assert.throws(() => parseDate("00/10/2025"));
});
