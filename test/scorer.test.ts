import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scorer } from "../src/index.js";
import type { Answers, Weights } from "../src/index.js";

const W1: Weights = [50, 30, 20];
const W2: Weights = [0, 0, 100];
const W3: Weights = [34, 33, 33];

function expected(answers: Answers, weights: Weights): number {
  return (answers[0] * weights[0] + answers[1] * weights[1] + answers[2] * weights[2]) / 100;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("submit 后可通过 readScores 读到版本 1 的分数", async () => {
  const scorer = new Scorer({ weights: W1 });
  await scorer.submit("r1", [10, 10, 10]);
  await scorer.submit("r2", [2, 4, 6]);
  const result = await scorer.readScores(["r1", "r2", "missing"]);
  assert.equal(result.revision, 1);
  assert.equal(result.scores["r1"], expected([10, 10, 10], W1));
  assert.equal(result.scores["r2"], expected([2, 4, 6], W1));
  assert.equal("missing" in result.scores, false);
  scorer.close();
});

test("回算期间提交新响应：读取仍为版本 1 且包含新响应，发布后也包含它", async () => {
  const scorer = new Scorer({ weights: W1, batchSize: 1 });
  await scorer.submit("r1", [1, 2, 3]);
  await scorer.submit("r2", [4, 5, 6]);
  await scorer.submit("r3", [7, 8, 9]);

  const recalc = scorer.recalculate(2, W2);
  // 回算已登记但尚未发布，此时提交新响应。
  await scorer.submit("r4", [10, 9, 8]);

  // 回算期间读取：仍为版本 1，且包含 r4。
  const during = await scorer.readScores(["r1", "r4"]);
  assert.equal(during.revision, 1);
  assert.equal(during.scores["r1"], expected([1, 2, 3], W1));
  assert.equal(during.scores["r4"], expected([10, 9, 8], W1));

  const result = await recalc;
  assert.equal(result, "published");

  // 版本 2 发布后：包含回算期间新增的 r4。
  const after = await scorer.readScores(["r1", "r2", "r3", "r4"]);
  assert.equal(after.revision, 2);
  assert.equal(after.scores["r1"], expected([1, 2, 3], W2));
  assert.equal(after.scores["r2"], expected([4, 5, 6], W2));
  assert.equal(after.scores["r3"], expected([7, 8, 9], W2));
  assert.equal(after.scores["r4"], expected([10, 9, 8], W2));
  scorer.close();
});

test("版本 3 先发布，版本 2 晚完成返回 superseded 且版本与分数不倒退", async () => {
  const scorer = new Scorer({ weights: W1, batchSize: 1 });
  await scorer.submit("r1", [1, 2, 3]);
  await scorer.submit("r2", [4, 5, 6]);
  await scorer.submit("r3", [7, 8, 9]);

  const recalc2 = scorer.recalculate(2, W2);
  await tick(); // 让版本 2 开始回算但尚未完成
  const recalc3 = scorer.recalculate(3, W3);

  const result3 = await recalc3;
  assert.equal(result3, "published");

  // 版本 3 发布后读取为新版本分数。
  const mid = await scorer.readScores(["r1", "r2", "r3"]);
  assert.equal(mid.revision, 3);
  assert.equal(mid.scores["r1"], expected([1, 2, 3], W3));

  const result2 = await recalc2;
  assert.equal(result2, "superseded");

  // 旧任务晚完成：版本不倒退，分数不被旧版本覆盖。
  const after = await scorer.readScores(["r1", "r2", "r3"]);
  assert.equal(after.revision, 3);
  assert.equal(after.scores["r1"], expected([1, 2, 3], W3));
  assert.equal(after.scores["r2"], expected([4, 5, 6], W3));
  assert.equal(after.scores["r3"], expected([7, 8, 9], W3));
  scorer.close();
});

test("recalculate 的版本号必须按登记顺序严格递增", async () => {
  const scorer = new Scorer({ weights: W1 });
  await assert.rejects(() => scorer.recalculate(3, W2), /revision must be 2/);
  await assert.rejects(() => scorer.recalculate(1, W2), /revision must be 2/);
  scorer.close();
});

test("参数校验：答案与权重非法时抛错", async () => {
  const scorer = new Scorer({ weights: W1 });
  await assert.rejects(() => scorer.submit("r1", [0, 5, 5]));
  await assert.rejects(() => scorer.submit("r1", [1, 5, 11]));
  await assert.rejects(() => scorer.submit("r1", [1.5, 5, 5]));
  await assert.rejects(() => scorer.recalculate(2, [50, 50, 1] as Weights));
  await assert.rejects(() => scorer.recalculate(2, [-1, 50, 51] as Weights));
  assert.throws(() => new Scorer({ weights: [10, 10, 10] as Weights }));
  scorer.close();
});

test("重复提交同一 id 抛错", async () => {
  const scorer = new Scorer({ weights: W1 });
  await scorer.submit("r1", [1, 1, 1]);
  await assert.rejects(() => scorer.submit("r1", [2, 2, 2]));
  scorer.close();
});

test("使用 dbPath 持久化：重开后保留已发布版本与分数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scorer-"));
  try {
    const dbPath = join(dir, "scores.db");
    const first = new Scorer({ dbPath, weights: W1 });
    await first.submit("r1", [2, 4, 6]);
    assert.equal(await first.recalculate(2, W2), "published");
    first.close();

    const second = new Scorer({ dbPath, weights: W1 });
    const result = await second.readScores(["r1"]);
    assert.equal(result.revision, 2);
    assert.equal(result.scores["r1"], expected([2, 4, 6], W2));
    await second.submit("r2", [3, 3, 3]);
    const again = await second.readScores(["r2"]);
    assert.equal(again.revision, 2);
    assert.equal(again.scores["r2"], expected([3, 3, 3], W2));
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
