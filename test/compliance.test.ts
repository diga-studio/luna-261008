import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompliance, suggestRepair } from "../src/index.js";
import type { Challenge } from "../src/index.js";

const NO_FORBIDDEN: Challenge = { forbiddenFragments: [] };

test("达标判定：长度边界", () => {
  assert.equal(checkCompliance("a1!bcdefghi", NO_FORBIDDEN), false); // 11
  assert.equal(checkCompliance("a1!bcdefghij", NO_FORBIDDEN), true); // 12
  assert.equal(checkCompliance("a1!bcdefghijklmnopqr", NO_FORBIDDEN), true); // 20
  assert.equal(checkCompliance("a1!bcdefghijklmnopqrs", NO_FORBIDDEN), false); // 21
});

test("达标判定：必须含数字与特殊符号", () => {
  assert.equal(checkCompliance("abc!defghijk", NO_FORBIDDEN), false); // 无数字
  assert.equal(checkCompliance("abc1defghijk", NO_FORBIDDEN), false); // 无特殊符号
  assert.equal(checkCompliance("abc1defghij!", NO_FORBIDDEN), true);
});

test("达标判定：连续三个相同字符", () => {
  assert.equal(checkCompliance("aaa1!bcdefghij", NO_FORBIDDEN), false);
  assert.equal(checkCompliance("aa11!bcdefghij", NO_FORBIDDEN), true);
  assert.equal(checkCompliance("ab1!bcdefgh!!!", NO_FORBIDDEN), false);
});

test("达标判定：禁用片段按连续子串判断", () => {
  const challenge: Challenge = { forbiddenFragments: ["abc", "xyz"] };
  assert.equal(checkCompliance("xxabc1!efghij", challenge), false);
  assert.equal(checkCompliance("xabcxyz1!efgh", challenge), false);
  assert.equal(checkCompliance("xabxcyz1!efgh", challenge), true);
  // 不是按单词判断：作为更长串的子串也算命中
  assert.equal(checkCompliance("1!zabcdefghjk", challenge), false);
});

test("达标判定：重叠与相互包含的禁用片段同时生效", () => {
  const challenge: Challenge = { forbiddenFragments: ["ab", "abc", "bc"] };
  assert.equal(checkCompliance("1!abdefghijkl", challenge), false); // 含 ab/abc
  assert.equal(checkCompliance("1!bcdefghijkl", challenge), false); // 含 bc
  assert.equal(checkCompliance("1!acdefghijkl", challenge), true);
});

test("达标判定：非法字符一律不达标而不是抛错", () => {
  assert.equal(checkCompliance("ABC1!defghij", NO_FORBIDDEN), false);
  assert.equal(checkCompliance("abc1!defg￥ijk", NO_FORBIDDEN), false);
  assert.equal(checkCompliance("abc1 defghij", NO_FORBIDDEN), false);
});

test("输入校验：原字符串非法时抛错", () => {
  assert.throws(() => suggestRepair("a".repeat(33), NO_FORBIDDEN), /32/);
  assert.throws(() => suggestRepair("ABC", NO_FORBIDDEN), /非法字符/);
  assert.throws(() => suggestRepair("abc def", NO_FORBIDDEN), /非法字符/);
  // 空串与 32 字符均为合法输入
  assert.doesNotThrow(() => suggestRepair("", NO_FORBIDDEN));
  assert.doesNotThrow(() => suggestRepair("a".repeat(32), NO_FORBIDDEN));
});

test("输入校验：题目非法时抛错", () => {
  assert.throws(() => suggestRepair("abc", { forbiddenFragments: ["a"] }), /2 至 6/);
  assert.throws(() => suggestRepair("abc", { forbiddenFragments: ["abcdefg"] }), /2 至 6/);
  assert.throws(
    () => suggestRepair("abc", { forbiddenFragments: Array(9).fill("ab") }),
    /8/,
  );
  assert.throws(() => suggestRepair("abc", { forbiddenFragments: ["A1"] }), /非法字符/);
  // 特殊符号组成的片段是合法题目
  assert.doesNotThrow(() =>
    checkCompliance("abc1!defghij", { forbiddenFragments: ["!!"] }),
  );
});
