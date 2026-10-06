import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceSpan, normalizeAnchor, normalizePage } from "../src/normalize";

test("NFKC composes combining sequences and maps to all participants", () => {
  const raw = "éx";
  const norm = normalizePage(raw);
  assert.equal(norm.text, "éx");
  const span = evidenceSpan(norm, 0, 1);
  assert.deepEqual(span, { start: 0, end: 2 });
  assert.equal(raw.slice(span.start, span.end), "é");
});

test("ligature expansion: partial hit still covers the whole original cluster", () => {
  const raw = "ﬃsh";
  const norm = normalizePage(raw);
  assert.equal(norm.text, "ffish");
  // "fi" is a partial hit of the expanded "ffi"; evidence is the whole "ﬃ".
  const span = evidenceSpan(norm, 0, 2);
  assert.deepEqual(span, { start: 0, end: 1 });
  assert.equal(raw.slice(span.start, span.end), "ﬃ");
});

test("soft hyphen is removed; interior one is covered, boundary one is not", () => {
  const interior = normalizePage("c­d");
  assert.equal(interior.text, "cd");
  assert.deepEqual(evidenceSpan(interior, 0, 2), { start: 0, end: 3 });

  const leading = normalizePage("­ab");
  assert.equal(leading.text, "ab");
  assert.deepEqual(evidenceSpan(leading, 0, 2), { start: 1, end: 3 });
});

test("whitespace runs collapse to one space covering the whole run", () => {
  const raw = "a \t\n b";
  const norm = normalizePage(raw);
  assert.equal(norm.text, "a b");
  const span = evidenceSpan(norm, 1, 2);
  assert.deepEqual(span, { start: 1, end: 5 });
  assert.equal(raw.slice(span.start, span.end), " \t\n ");
});

test("collapsed leading/trailing spaces are kept", () => {
  const norm = normalizePage("  x  ");
  assert.equal(norm.text, " x ");
  assert.deepEqual(evidenceSpan(norm, 0, 3), { start: 0, end: 5 });
});

test("anchor uses the same normalization pipeline", () => {
  assert.equal(normalizeAnchor("ﬁsh  ­bone"), "fish bone");
});

test("empty range yields an empty span at the boundary", () => {
  const norm = normalizePage("ab");
  assert.deepEqual(evidenceSpan(norm, 1, 1), { start: 1, end: 1 });
  assert.deepEqual(evidenceSpan(norm, 2, 2), { start: 2, end: 2 });
});
