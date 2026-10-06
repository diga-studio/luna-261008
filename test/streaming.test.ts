import { test } from "node:test";
import assert from "node:assert/strict";
import { DestructiveSqlAnalyzer, analyze, type AnalysisResult } from "../src/index.js";
import { COMPLEX_SQL, expectedComplexHits } from "./fixture.js";

const COMPLEX_BYTES = new TextEncoder().encode(COMPLEX_SQL);

function analyzeChunks(chunks: Uint8Array[]): AnalysisResult {
  const a = new DestructiveSqlAnalyzer();
  for (const c of chunks) a.push(c);
  return a.end();
}

test("whole input matches the expected hit list", () => {
  const r = analyzeChunks([COMPLEX_BYTES]);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.hits, expectedComplexHits());
});

test("splitting at every single byte position is invariant", () => {
  const whole = analyzeChunks([COMPLEX_BYTES]);
  for (let i = 0; i <= COMPLEX_BYTES.length; i++) {
    const r = analyzeChunks([COMPLEX_BYTES.subarray(0, i), COMPLEX_BYTES.subarray(i)]);
    assert.deepEqual(r, whole, `split at byte ${i}`);
  }
});

test("feeding one byte at a time is invariant", () => {
  const whole = analyzeChunks([COMPLEX_BYTES]);
  const a = new DestructiveSqlAnalyzer();
  for (let i = 0; i < COMPLEX_BYTES.length; i++) {
    a.push(COMPLEX_BYTES.subarray(i, i + 1));
  }
  assert.deepEqual(a.end(), whole);
});

test("random multi-way splits are invariant", () => {
  const whole = analyzeChunks([COMPLEX_BYTES]);
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 50; round++) {
    const cuts = new Set<number>();
    const nCuts = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < nCuts; i++) cuts.add(Math.floor(rand() * COMPLEX_BYTES.length));
    const points = [0, ...[...cuts].sort((a, b) => a - b), COMPLEX_BYTES.length];
    const chunks: Uint8Array[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      chunks.push(COMPLEX_BYTES.subarray(points[i], points[i + 1]));
    }
    assert.deepEqual(analyzeChunks(chunks), whole, `round ${round} cuts ${[...cuts]}`);
  }
});

test("string input and Uint8Array input agree", () => {
  assert.deepEqual(analyze(COMPLEX_SQL), analyzeChunks([COMPLEX_BYTES]));
});

test("incomplete status is preserved under chunking", () => {
  const sql = `DROP TABLE done1; SELECT 'open`;
  const bytes = new TextEncoder().encode(sql);
  const whole = analyzeChunks([bytes]);
  assert.equal(whole.status, "incomplete");
  for (let i = 0; i <= bytes.length; i++) {
    const r = analyzeChunks([bytes.subarray(0, i), bytes.subarray(i)]);
    assert.deepEqual(r, whole, `split at byte ${i}`);
  }
});
