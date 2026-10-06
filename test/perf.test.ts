import test from "node:test";
import assert from "node:assert/strict";
import { isCompliant, suggestRepair } from "../src/index";
import { Challenge } from "../src/types";
import { levenshtein, mulberry32 } from "./reference";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789!@#";

function maxSpecCase(seed: number): { original: string; challenge: Challenge } {
  const rand = mulberry32(seed);
  let original = "";
  for (let k = 0; k < 32; k++) {
    original += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  const fragments: string[] = [];
  for (let f = 0; f < 8; f++) {
    let fragment = "";
    for (let k = 0; k < 6; k++) {
      fragment += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    }
    fragments.push(fragment);
  }
  return { original, challenge: { bannedFragments: fragments } };
}

function footprint(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

test("max spec suggestion returns within 3 seconds and 128 MiB", () => {
  const { original, challenge } = maxSpecCase(7);
  if (global.gc) {
    global.gc();
  }
  const memBefore = footprint();
  const start = process.hrtime.bigint();
  const result = suggestRepair(original, challenge);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const memAfter = footprint();

  assert.ok(elapsedMs < 3000, `took ${elapsedMs.toFixed(1)}ms`);
  assert.ok(
    memAfter - memBefore < 128 * 1024 * 1024,
    `used ${((memAfter - memBefore) / 1048576).toFixed(1)} MiB`,
  );
  assert.ok(isCompliant(result.password, challenge));
  assert.equal(levenshtein(original, result.password), result.changes);
});

test("repeated solves do not accumulate memory", () => {
  const cases = [maxSpecCase(11), maxSpecCase(23), maxSpecCase(47)];
  for (const { original, challenge } of cases) {
    suggestRepair(original, challenge);
  }
  if (global.gc) {
    global.gc();
  }
  const baseline = footprint();
  for (let round = 0; round < 30; round++) {
    const { original, challenge } = cases[round % cases.length];
    const result = suggestRepair(original, challenge);
    assert.ok(isCompliant(result.password, challenge));
  }
  if (global.gc) {
    global.gc();
  }
  const growth = footprint() - baseline;
  assert.ok(
    growth < 16 * 1024 * 1024,
    `memory grew by ${(growth / 1048576).toFixed(1)} MiB across repeated solves`,
  );
});
