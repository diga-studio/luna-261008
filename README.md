# doc-field-extractor

In-memory document field extraction for TypeScript. Input is raw Unicode
text per page plus field rules; output is every non-empty normalized field
value with traceable evidence spans into the original page text. Nothing
is persisted — rules, text and results live only in memory.

## Usage

```ts
import { extractFields } from "doc-field-extractor";

const pages = ["Invoice No. 42\nTotal: 100 USD"]; // raw page texts
const result = extractFields(pages, [
  {
    name: "invoiceNo",
    anchor: "Invoice No.", // literal keyword
    pattern: /(?<value>\d+)/, // must capture a named "value" group
  },
]);

for (const c of result.candidates) {
  // c.field, c.value, c.page
  // c.anchor / c.valueSpan: half-open UTF-16 spans into the ORIGINAL page
  const evidence = pages[c.page].slice(c.valueSpan.start, c.valueSpan.end);
}
```

`result.pages` holds the normalized per-page match text.

## Matching model

- Each page is normalized independently: NFKC, then U+00AD soft hyphens
  are removed, then every run of Unicode `White_Space` collapses to one
  ASCII space (leading/trailing collapsed spaces are kept). Pages are
  never concatenated.
- Anchors are normalized with the same pipeline and matched literally,
  left to right, non-overlapping. Each anchor end to the next same-rule
  anchor start (or page end) forms a search region. Pages without the
  anchor produce no candidates for that rule.
- Each region is matched independently with the rule's pattern executed
  as a Unicode (`u`), global (`g`), indices (`d`) RegExp. The pattern
  source is never rewritten; sticky (`y`) is dropped, other flags kept.
- Only non-empty `value` captures become candidates; no ranking or
  deduplication is applied.
- Zero-length overall matches produce at most one candidate per code
  point boundary; the scan then advances one full code point (surrogate
  pairs are never split) and continues.

## Evidence spans

- Spans are half-open `[start, end)` UTF-16 code unit offsets into the
  original (un-normalized) page text, so `page.slice(start, end)` always
  returns the evidence.
- A span is the minimal continuous range covering every contributing
  character, widened to whole extended grapheme clusters: composed
  characters count all participating code units, expanded characters
  (e.g. the `ﬃ` ligature) contribute as a whole even on a partial hit,
  and collapsed whitespace covers the entire original run. Removed soft
  hyphens are included only when interior to the covered range.
- `value` groups inside lookaheads/lookbehinds are located by their own
  capture indices, not by the overall match range.

## Develop

```sh
npm install
npm test   # tsc + node --test
```

Only devDependency is `typescript`; tests run on the built-in Node test
runner (Node 18+).
