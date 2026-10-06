import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { normalizePage, toOriginalSpan } from "../src/index";

test("pipeline: NFKC, soft hyphen removal, whitespace collapse", () => {
  // Soft hyphen is dropped; NBSP becomes a space via NFKC, then collapses.
  const page = normalizePage("\u00ADA\u00A0\u00A0B ");
  equal(page.text, "A B ");
});

test("collapsed leading and trailing whitespace is kept", () => {
  equal(normalizePage("  x\t\n").text, " x ");
});

test("U+FEFF is not Unicode White_Space and survives", () => {
  equal(normalizePage("a\uFEFFb").text, "a\uFEFFb");
});

test("ligature partial hit maps to the whole original cluster", () => {
  const raw = "x \uFB03le";
  const page = normalizePage(raw);
  equal(page.text, "x ffile");
  // "fi" inside the expanded "ffi" still comes from the single char U+FB03.
  const span = toOriginalSpan(page, 3, 5);
  deepEqual(span, { start: 2, end: 3 });
  equal(raw.slice(span.start, span.end), "\uFB03");
});

test("composed character: all participating code units contribute", () => {
  const raw = "cafe\u0301"; // é written as e + U+0301
  const page = normalizePage(raw);
  equal(page.text, "caf\u00E9"); // composed by NFKC
  const span = toOriginalSpan(page, 3, 4);
  deepEqual(span, { start: 3, end: 5 });
  equal(raw.slice(span.start, span.end), "e\u0301");
});

test("collapsed whitespace covers the whole original run", () => {
  const raw = "x   y";
  const page = normalizePage(raw);
  equal(page.text, "x y");
  const span = toOriginalSpan(page, 1, 2);
  deepEqual(span, { start: 1, end: 4 });
  equal(raw.slice(span.start, span.end), "   ");
});

test("soft hyphen is included only when interior to the span", () => {
  const raw = "co\u00ADoperate";
  const page = normalizePage(raw);
  equal(page.text, "cooperate");
  // Span covering both sides of the deleted hyphen includes it.
  const whole = toOriginalSpan(page, 0, 9);
  equal(raw.slice(whole.start, whole.end), "co\u00ADoperate");
  // Span fully after the hyphen excludes it.
  const tail = toOriginalSpan(page, 2, 9);
  equal(raw.slice(tail.start, tail.end), "operate");
});

test("astral characters keep correct UTF-16 offsets", () => {
  const raw = "𠀀xy";
  const page = normalizePage(raw);
  equal(page.text, "𠀀xy");
  deepEqual(toOriginalSpan(page, 2, 3), { start: 2, end: 3 });
  deepEqual(toOriginalSpan(page, 0, 2), { start: 0, end: 2 });
});
