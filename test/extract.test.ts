import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFields } from "../src/extract";
import type { FieldRule } from "../src/types";

function rule(name: string, anchor: string, pattern: RegExp): FieldRule {
  return { name, anchor, pattern };
}

test("ligature partial hit: normalized value vs minimal original span", () => {
  const page = "K ﬃle 9";
  const [c] = extractFields([page], [rule("word", "K", /(?<value>fi)/)]);
  assert.equal(c.value, "fi");
  // Evidence is exactly the original "ﬃ", not the whole line.
  assert.equal(page.slice(c.valueSpan.start, c.valueSpan.end), "ﬃ");
  assert.deepEqual(c.valueSpan, { start: 2, end: 3 });
  assert.equal(page.slice(c.anchorSpan.start, c.anchorSpan.end), "K");
});

test("value spanning expansion and plain chars slices the right original text", () => {
  const page = "K ﬃle 9";
  const [c] = extractFields([page], [rule("word", "K", /(?<value>\w+?le)/)]);
  assert.equal(c.value, "ffile");
  assert.equal(page.slice(c.valueSpan.start, c.valueSpan.end), "ﬃle");
});

test("repeated anchors on one page keep candidates inside their regions", () => {
  const page = "A 1 A 22";
  const out = extractFields([page], [rule("n", "A", /(?<value>\d+ \d+|\d+)/)]);
  // Region 1 is " 1 " and region 2 is " 22"; a cross-region "1 A 22"-style
  // match must never happen.
  assert.deepEqual(out.map((c) => c.value), ["1", "22"]);
  assert.equal(page.slice(out[0].valueSpan.start, out[0].valueSpan.end), "1");
  assert.equal(page.slice(out[1].valueSpan.start, out[1].valueSpan.end), "22");
  assert.deepEqual(
    out.map((c) => page.slice(c.anchorSpan.start, c.anchorSpan.end)),
    ["A", "A"],
  );
});

test("same field across pages yields independent per-page candidates", () => {
  const pages = ["A 1", "no anchor here", "A 2"];
  const out = extractFields(pages, [rule("n", "A", /(?<value>\d+)/)]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => [c.page, c.value]), [[0, "1"], [2, "2"]]);
  assert.equal(pages[0].slice(out[0].valueSpan.start, out[0].valueSpan.end), "1");
  assert.equal(pages[2].slice(out[1].valueSpan.start, out[1].valueSpan.end), "2");
});

test("anchor normalization matches ligature in document", () => {
  const page = "ﬁsh: 3";
  const [c] = extractFields([page], [rule("n", "fish:", /(?<value>\d+)/)]);
  assert.equal(c.value, "3");
  assert.equal(page.slice(c.anchorSpan.start, c.anchorSpan.end), "ﬁsh:");
});

test("lookbehind value is located by its own capture, not the whole match", () => {
  const page = "A $5";
  const [c] = extractFields([page], [rule("n", "A", /(?<=\$)(?<value>\d+)/)]);
  assert.equal(c.value, "5");
  assert.equal(page.slice(c.valueSpan.start, c.valueSpan.end), "5");
});

test("lookahead value in a zero-length match still produces a located candidate", () => {
  const page = "A 12";
  const out = extractFields([page], [rule("n", "A", /(?=(?<value>\d+))/)]);
  assert.deepEqual(out.map((c) => c.value), ["12", "2"]);
  assert.equal(page.slice(out[0].valueSpan.start, out[0].valueSpan.end), "12");
  assert.equal(page.slice(out[1].valueSpan.start, out[1].valueSpan.end), "2");
});

test("zero-length matches never split surrogate pairs", () => {
  const page = "A 😀 5";
  const out = extractFields([page], [rule("n", "A", /(?=(?<value>.))/u)]);
  // One candidate per code point boundary, never half of "😀".
  assert.deepEqual(out.map((c) => c.value), [" ", "😀", " ", "5"]);
  const emoji = out.find((c) => c.value === "😀")!;
  assert.equal(page.slice(emoji.valueSpan.start, emoji.valueSpan.end), "😀");
});

test("empty captures are dropped", () => {
  const page = "A x";
  const out = extractFields([page], [rule("n", "A", /(?<value>\d*)/)]);
  assert.deepEqual(out, []);
});

test("soft hyphen and whitespace collapse participate in matching and spans", () => {
  const page = "To­tal:   7";
  const [c] = extractFields([page], [rule("n", "Total: ", /(?<value>\d+)/)]);
  assert.equal(c.value, "7");
  // Anchor span covers the interior soft hyphen and the collapsed spaces.
  assert.equal(page.slice(c.anchorSpan.start, c.anchorSpan.end), "To­tal:   ");
  assert.equal(page.slice(c.valueSpan.start, c.valueSpan.end), "7");
});

test("rules with an anchor missing on a page produce nothing for that page", () => {
  const out = extractFields(["nothing"], [rule("n", "A", /(?<value>\d+)/)]);
  assert.deepEqual(out, []);
});
