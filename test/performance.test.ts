import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCompliance, suggestRepair } from "../src/index.js";
import type { Challenge } from "../src/index.js";

/** 最大规格题目：32 字符原串 + 8 个长度为 6 的禁用片段。 */
const MAX_CHALLENGE: Challenge = {
  forbiddenFragments: [
    "qzxywv",
    "jjqzkq",
    "!@#abc",
    "09az!q",
    "mmmmmm",
    "qwerty",
    "zxcvbn",
    "!a1b2c",
  ],
};
const MAX_SOURCE = "qzxywvjjqzkq!@#abc09az!qmmmmmmqw"; // 32 字符

const gc = (globalThis as { gc?: () => void }).gc;

test("性能：最大规格单次建议在 3 秒内返回", () => {
  const start = performance.now();
  const result = suggestRepair(MAX_SOURCE, MAX_CHALLENGE);
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < 3000,
    `最大规格求解耗时 ${elapsed.toFixed(1)}ms，超过 3000ms`,
  );
  assert.ok(checkCompliance(result.suggestion, MAX_CHALLENGE));
});

test("内存：单次求解堆增量不超过 128 MiB", () => {
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const result = suggestRepair(MAX_SOURCE, MAX_CHALLENGE);
  const during = process.memoryUsage().heapUsed;
  assert.ok(checkCompliance(result.suggestion, MAX_CHALLENGE));
  const growth = during - before;
  assert.ok(
    growth < 128 * 1024 * 1024,
    `单次求解堆增量 ${(growth / 1024 / 1024).toFixed(1)} MiB，超过 128 MiB`,
  );
});

test("内存：重复求解不持续累积状态", () => {
  // 交替处理不同题目，模拟训练平台反复调用
  const challenges: Challenge[] = [
    MAX_CHALLENGE,
    { forbiddenFragments: ["aa", "bb"] },
    { forbiddenFragments: [] },
  ];
  const sources = [MAX_SOURCE, "aaaaaaaaaa", "", "z".repeat(32)];
  for (let round = 0; round < 20; round += 1) {
    for (const source of sources) {
      for (const challenge of challenges) {
        suggestRepair(source, challenge);
      }
    }
  }
  gc?.();
  const baseline = process.memoryUsage().heapUsed;
  for (let round = 0; round < 40; round += 1) {
    for (const source of sources) {
      for (const challenge of challenges) {
        suggestRepair(source, challenge);
      }
    }
  }
  gc?.();
  const growth = process.memoryUsage().heapUsed - baseline;
  assert.ok(
    growth < 16 * 1024 * 1024,
    `重复求解后堆增长 ${(growth / 1024 / 1024).toFixed(1)} MiB，疑似状态泄漏`,
  );
});
