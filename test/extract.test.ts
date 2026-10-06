import { test } from "node:test";
import { equal, deepEqual, throws } from "node:assert/strict";
import { extractFields } from "../src/index";
import type { FieldRule } from "../src/index";

function rule(name: string, anchor: string, source: string, flags = ""): FieldRule {
  return { name, anchor, pattern: new RegExp(source, flags) };
}

test("ligature partial hit: normalized value, minimal original evidence", () => {
  const raw = "key \uFB03le end";
  const { candidates } = extractFields([raw], [rule("v", "key", "(?<value>fi)")]);
  equal(candidates.length, 1);
  const c = candidates[0];
  equal(c.value, "fi");
  // The whole ligature U+FB03 is the evidence; it must not grow to the line.
  deepEqual(c.valueSpan, { start: 4, end: 5 });
  equal(raw.slice(c.valueSpan.start, c.valueSpan.end), "\uFB03");
  deepEqual(c.anchor, { start: 0, end: 3 });
});

test("repeated anchors on one page isolate search regions", () => {
  const raw = "A 11 A 22";
  const { candidates } = extractFields([raw], [rule("n", "A", "(?<value>\\d+)")]);
  equal(candidates.length, 2);
  equal(candidates[0].value, "11");
  deepEqual(candidates[0].valueSpan, { start: 2, end: 4 });
  deepEqual(candidates[0].anchor, { start: 0, end: 1 });
  equal(candidates[1].value, "22");
  deepEqual(candidates[1].valueSpan, { start: 7, end: 9 });
  deepEqual(candidates[1].anchor, { start: 5, end: 6 });
  // A pattern spanning two regions must not produce any candidate.
  const cross = extractFields([raw], [rule("n", "A", "(?<value>\\d+ A \\d+)")]);
  equal(cross.candidates.length, 0);
});

test("same field across pages: candidates keep their own page and spans", () => {
  const pages = ["A 100", "A 200"];
  const { candidates } = extractFields(pages, [rule("amount", "A", "(?<value>\\d+)")]);
  equal(candidates.length, 2);
  equal(candidates[0].page, 0);
  equal(candidates[0].value, "100");
  equal(pages[0].slice(candidates[0].valueSpan.start, candidates[0].valueSpan.end), "100");
  equal(candidates[1].page, 1);
  equal(candidates[1].value, "200");
  equal(pages[1].slice(candidates[1].valueSpan.start, candidates[1].valueSpan.end), "200");
});

test("value group inside lookbehind is located by its own capture", () => {
  const raw = "total: 42 USD";
  const { candidates } = extractFields([raw], [rule("n", "total:", "(?<=(?<value>\\d+)) USD")]);
  equal(candidates.length, 1);
  equal(candidates[0].value, "42");
  equal(raw.slice(candidates[0].valueSpan.start, candidates[0].valueSpan.end), "42");
});

test("value group inside lookahead is located by its own capture", () => {
  const raw = "k x 42";
  const { candidates } = extractFields([raw], [rule("n", "k", "x (?=(?<value>\\d+))")]);
  equal(candidates.length, 1);
  equal(candidates[0].value, "42");
  // The span covers only the captured digits, not the "x " overall match.
  deepEqual(candidates[0].valueSpan, { start: 4, end: 6 });
});

test("zero-length matches: one candidate per boundary, search continues", () => {
  const raw = "A x 12 3";
  const { candidates } = extractFields([raw], [rule("n", "A", "(?=(?<value>\\d+))")]);
  deepEqual(candidates.map((c) => c.value), ["12", "2", "3"]);
  deepEqual(candidates[0].valueSpan, { start: 4, end: 6 });
  deepEqual(candidates[2].valueSpan, { start: 7, end: 8 });
});

test("zero-length advance never splits a surrogate pair", () => {
  const raw = "A \uD840\uDC00y";
  const { candidates } = extractFields([raw], [rule("n", "A", "(?=(?<value>[\\s\\S]))")]);
  deepEqual(candidates.map((c) => c.value), [" ", "\uD840\uDC00", "y"]);
  equal(raw.slice(candidates[1].valueSpan.start, candidates[1].valueSpan.end), "\uD840\uDC00");
  deepEqual(candidates[1].valueSpan, { start: 2, end: 4 });
});

test("empty values are dropped; pages without the anchor yield nothing", () => {
  const empty = extractFields(["A xyz"], [rule("n", "A", "(?<value>\\d*)")]);
  equal(empty.candidates.length, 0);
  const noAnchor = extractFields(["nothing here"], [rule("n", "A", "(?<value>\\d+)")]);
  equal(noAnchor.candidates.length, 0);
});

test("anchor keyword is normalized like the document", () => {
  const raw = "see \uFB01le 9"; // contains U+FB01 (ﬁ)
  const { candidates, pages } = extractFields([raw], [rule("n", "file", "(?<value>\\d+)")]);
  equal(pages[0], "see file 9");
  equal(candidates.length, 1);
  equal(candidates[0].value, "9");
  // Anchor evidence covers the original ligature form.
  equal(raw.slice(candidates[0].anchor.start, candidates[0].anchor.end), "\uFB01le");
  deepEqual(candidates[0].anchor, { start: 4, end: 7 });
});

test("soft hyphen interior to anchor evidence is included", () => {
  const raw = "co\u00ADoperate: 5";
  const { candidates } = extractFields([raw], [rule("n", "cooperate", "(?<value>\\d+)")]);
  equal(candidates.length, 1);
  equal(raw.slice(candidates[0].anchor.start, candidates[0].anchor.end), "co­operate");
  equal(candidates[0].value, "5");
});

test("collapsed whitespace inside value evidence covers the original run", () => {
  const raw = "A  x   y";
  const { candidates, pages } = extractFields([raw], [rule("n", "A", "(?<value>x y)")]);
  equal(pages[0], "A x y");
  equal(candidates.length, 1);
  equal(candidates[0].value, "x y");
  equal(raw.slice(candidates[0].valueSpan.start, candidates[0].valueSpan.end), "x   y");
});

test("invalid rules are rejected", () => {
  throws(() => extractFields(["x"], [rule("n", "\u00AD", "(?<value>y)")]));
  throws(() => extractFields(["x"], [rule("n", "x", "(value)")]));
});
