import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompliance, suggestRepair } from "../src/index.js";
import type { Challenge } from "../src/index.js";
import { baselineMinEdits, levenshtein } from "./baseline.js";

const NO_FORBIDDEN: Challenge = { forbiddenFragments: [] };

/** 建议结果必须同时满足：达标、编辑距离恰为 minEdits、与独立基准一致。 */
function assertOptimal(
  source: string,
  challenge: Challenge,
  expected: number,
): void {
  const { minEdits, suggestion } = suggestRepair(source, challenge);
  assert.equal(minEdits, expected, `minEdits of ${source}`);
  assert.ok(
    checkCompliance(suggestion, challenge),
    `建议串 ${suggestion} 必须达标`,
  );
  assert.equal(
    levenshtein(source, suggestion),
    minEdits,
    `建议串 ${suggestion} 必须恰好以 ${minEdits} 次修改可达`,
  );
  assert.equal(
    baselineMinEdits(source, challenge.forbiddenFragments),
    minEdits,
    "最少次数须与独立基准一致",
  );
}

test("验收：无禁用片段时 aaaaaaaaaa 最少修改 4 次", () => {
  assertOptimal("aaaaaaaaaa", NO_FORBIDDEN, 4);
});

test("验收：aaaaaaaaaaaa 禁用 aa 时最少修改 6 次", () => {
  assertOptimal("aaaaaaaaaaaa", { forbiddenFragments: ["aa"] }, 6);
});

test("已达标原串返回 0 次修改与原串", () => {
  const challenge: Challenge = { forbiddenFragments: ["xyz"] };
  const source = "abc1!defghij";
  assert.ok(checkCompliance(source, challenge));
  const result = suggestRepair(source, challenge);
  assert.equal(result.minEdits, 0);
  assert.equal(result.suggestion, source);
});

test("空原串：纯插入构造达标串", () => {
  assertOptimal("", NO_FORBIDDEN, 12);
});

test("超长原串：删除与替换共同作用", () => {
  // 25 个 a：需删到 20 以内、打破连续、补齐数字与特殊符号
  const source = "a".repeat(25);
  // 至少删 5 个字符；长度 20 内至多每 3 位 2 个 a，至少替换 6 个，合计 11
  assertOptimal(source, NO_FORBIDDEN, 11);
  // 32 个字符（上限）的超长输入
  const source32 = "z".repeat(32);
  const { minEdits, suggestion } = suggestRepair(source32, NO_FORBIDDEN);
  assert.ok(suggestion.length <= 20);
  assert.equal(levenshtein(source32, suggestion), minEdits);
  assert.ok(checkCompliance(suggestion, NO_FORBIDDEN));
});

test("多个相互包含、重叠的禁用片段同时生效", () => {
  const challenge: Challenge = {
    forbiddenFragments: ["aba", "bab", "abba", "baab"],
  };
  const { minEdits, suggestion } = suggestRepair("abbabaababba", challenge);
  assert.ok(checkCompliance(suggestion, challenge));
  assert.equal(levenshtein("abbabaababba", suggestion), minEdits);
  assert.equal(baselineMinEdits("abbabaababba", challenge.forbiddenFragments), minEdits);
  // 另一组重叠片段
  assertOptimal("ababababab", { forbiddenFragments: ["aba", "bab", "abba"] }, 4);
});

test("禁用片段与连续重复、字符类型相互影响", () => {
  // 片段迫使插入位置改变，基准独立核对
  assertOptimal("hello1!world", { forbiddenFragments: ["hello", "world"] }, 2);
  assertOptimal("abcabcabcabc", { forbiddenFragments: ["abcab"] }, 2);
  assertOptimal("zz9!zz9!zz9!zz", { forbiddenFragments: ["9!zz"] }, 3);
});

test("多个最优建议时任选其一即可", () => {
  const { minEdits, suggestion } = suggestRepair("qwerty1!asdf", NO_FORBIDDEN);
  assert.equal(minEdits, 0);
  assert.equal(suggestion, "qwerty1!asdf");
});
