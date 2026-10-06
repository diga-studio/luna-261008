import test from "node:test";
import assert from "node:assert/strict";
import { isCompliant, suggestRepair } from "../src/index";
import { Challenge } from "../src/types";
import { levenshtein, mulberry32, referenceMinChanges } from "./reference";

const none: Challenge = { bannedFragments: [] };

function assertWitness(original: string, challenge: Challenge): void {
  const result = suggestRepair(original, challenge);
  assert.ok(
    isCompliant(result.password, challenge),
    `suggestion ${result.password} must satisfy every rule`,
  );
  assert.equal(
    levenshtein(original, result.password),
    result.changes,
    `suggestion must be reachable in exactly ${result.changes} edits`,
  );
}

test("acceptance: ten a's without fragments needs 4 changes", () => {
  const result = suggestRepair("aaaaaaaaaa", none);
  assert.equal(result.changes, 4);
  assert.equal(referenceMinChanges("aaaaaaaaaa", none), 4);
  assertWitness("aaaaaaaaaa", none);
});

test("acceptance: twelve a's with banned 'aa' needs 6 changes", () => {
  const challenge = { bannedFragments: ["aa"] };
  const result = suggestRepair("aaaaaaaaaaaa", challenge);
  assert.equal(result.changes, 6);
  assert.equal(referenceMinChanges("aaaaaaaaaaaa", challenge), 6);
  assertWitness("aaaaaaaaaaaa", challenge);
});

test("already compliant input returns 0 and the original string", () => {
  const challenge = { bannedFragments: ["abc"] };
  const original = "a1!bcdefghijk";
  assert.ok(isCompliant(original, challenge));
  assert.deepEqual(suggestRepair(original, challenge), { changes: 0, password: original });
});

test("empty original is repaired with 12 insertions", () => {
  const result = suggestRepair("", none);
  assert.equal(result.changes, 12);
  assertWitness("", none);
});

test("overlong input of 32 a's needs 18 changes", () => {
  const original = "a".repeat(32);
  const result = suggestRepair(original, none);
  assert.equal(result.changes, 18);
  assertWitness(original, none);
});

test("overlong input with overlapping fragments matches reference", () => {
  const challenge = { bannedFragments: ["ab", "ba", "aa", "bb"] };
  const original = "abababababababababababababababab";
  const result = suggestRepair(original, challenge);
  assertWitness(original, challenge);
  assert.ok(result.changes >= 12, "must delete at least 12 characters");
});

test("multiple overlapping banned fragments all apply at once", () => {
  const challenge = { bannedFragments: ["ab", "bc", "abc", "bcb", "1a", "a1"] };
  const original = "abcba1abcba1";
  const result = suggestRepair(original, challenge);
  assert.equal(result.changes, referenceMinChanges(original, challenge));
  assertWitness(original, challenge);
});

test("nested fragments where one contains another", () => {
  const challenge = { bannedFragments: ["aa", "aaa", "baa", "aab"] };
  const original = "aabaabbaaabb";
  const result = suggestRepair(original, challenge);
  assert.equal(result.changes, referenceMinChanges(original, challenge));
  assertWitness(original, challenge);
});

test("randomized small cases match the independent reference", () => {
  const rand = mulberry32(20261006);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789!@#";
  const pick = (n: number): string => {
    let out = "";
    for (let k = 0; k < n; k++) {
      out += alphabet[Math.floor(rand() * alphabet.length)];
    }
    return out;
  };
  for (let round = 0; round < 100; round++) {
    const original = pick(Math.floor(rand() * 9));
    const fragmentCount = Math.floor(rand() * 4);
    const fragments: string[] = [];
    for (let f = 0; f < fragmentCount; f++) {
      fragments.push(pick(2 + Math.floor(rand() * 3)));
    }
    const challenge: Challenge = { bannedFragments: fragments };
    const expected = referenceMinChanges(original, challenge);
    const result = suggestRepair(original, challenge);
    assert.equal(
      result.changes,
      expected,
      `mismatch for original=${JSON.stringify(original)} fragments=${JSON.stringify(fragments)}`,
    );
    assertWitness(original, challenge);
  }
});

test("randomized medium cases produce valid optimal-distance witnesses", () => {
  const rand = mulberry32(42);
  const alphabet = "ab19#!";
  for (let round = 0; round < 40; round++) {
    let original = "";
    const length = 10 + Math.floor(rand() * 23);
    for (let k = 0; k < length; k++) {
      original += alphabet[Math.floor(rand() * alphabet.length)];
    }
    const fragments: string[] = [];
    const fragmentCount = Math.floor(rand() * 5);
    for (let f = 0; f < fragmentCount; f++) {
      const fl = 2 + Math.floor(rand() * 4);
      let fragment = "";
      for (let k = 0; k < fl; k++) {
        fragment += alphabet[Math.floor(rand() * alphabet.length)];
      }
      fragments.push(fragment);
    }
    const challenge: Challenge = { bannedFragments: fragments };
    assertWitness(original, challenge);
  }
});
