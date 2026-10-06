import test from "node:test";
import assert from "node:assert/strict";
import { isCompliant, suggestRepair } from "../src/index";

const none = { bannedFragments: [] };

test("compliant password passes", () => {
  assert.equal(isCompliant("abcde12345!@", none), true);
  assert.equal(isCompliant("a1!bcdefghjk", none), true);
  assert.equal(isCompliant("x9#y8#z7#w6#v5#u4#t3", none), true);
});

test("length boundaries 12..20", () => {
  assert.equal(isCompliant("a1!bcdefghj", none), false);
  assert.equal(isCompliant("a1!bcdefghjk", none), true);
  assert.equal(isCompliant("a1!bcdefghijklmnopqr", none), true);
  assert.equal(isCompliant("a1!bcdefghijklmnopqrs", none), false);
});

test("requires at least one digit and one special", () => {
  assert.equal(isCompliant("abc!efghijkl", none), false);
  assert.equal(isCompliant("abc1efghijkl", none), false);
  assert.equal(isCompliant("abcdefghijk1", none), false);
});

test("rejects three identical consecutive characters", () => {
  assert.equal(isCompliant("aaa1!bcdefgh", none), false);
  assert.equal(isCompliant("aa1!bcdefghj", none), true);
  assert.equal(isCompliant("ab111cdef!gh", none), false);
  assert.equal(isCompliant("ab!!!cdef1gh", none), false);
});

test("banned fragments match as contiguous substrings", () => {
  const challenge = { bannedFragments: ["abc", "1!"] };
  assert.equal(isCompliant("xabcy12345!@", challenge), false);
  assert.equal(isCompliant("xaybyc12345!@", challenge), true);
  assert.equal(isCompliant("z9!bcdefgh1!j", challenge), false);
  assert.equal(isCompliant("z9!bcdefgh1aj", challenge), true);
});

test("rejects characters outside the allowed alphabet", () => {
  assert.equal(isCompliant("Abcde12345!@", none), false);
  assert.equal(isCompliant("abcde12345!$", none), false);
  assert.equal(isCompliant("abcde 12345!", none), false);
});

test("invalid challenge definitions are rejected", () => {
  assert.throws(() => isCompliant("abcde12345!@", { bannedFragments: ["a"] }), /length/);
  assert.throws(() => isCompliant("abcde12345!@", { bannedFragments: ["abcdefg"] }), /length/);
  assert.throws(() => isCompliant("abcde12345!@", { bannedFragments: ["AB"] }), /outside/);
  assert.throws(
    () => isCompliant("abcde12345!@", { bannedFragments: Array(9).fill("ab") }),
    /at most 8/,
  );
  assert.throws(() => isCompliant("abcde12345!@", { bannedFragments: [1 as never] }), /strings/);
});

test("suggestRepair rejects invalid originals", () => {
  assert.throws(() => suggestRepair("a".repeat(33), none), /at most 32/);
  assert.throws(() => suggestRepair("ABC", none), /outside/);
  assert.equal(suggestRepair("a".repeat(32), none).changes > 0, true);
});
