import assert from "node:assert/strict";
import { test } from "node:test";
import { Scorer } from "../src/scorer.js";
import type { Weights } from "../src/types.js";

const V1: Weights = [50, 30, 20];
const V2: Weights = [0, 0, 100];
const V3: Weights = [10, 10, 80];

test("回算期间提交新响应：读取仍为版本1且包含新响应，版本2发布后同样包含它", async () => {
  let midRead: Awaited<ReturnType<Scorer["readScores"]>> | undefined;
  // hook 在每个回算批次提交后被 await，借此保证 submit/read 发生在回算进行中
  const scorer = new Scorer({
    initialWeights: V1,
    onRecalculateBatch: async (info) => {
      if (info.revision === 2 && !midRead) {
        await scorer.submit("r_new", [2, 4, 6]);
        midRead = await scorer.readScores(["r1", "r2", "r_new"]);
      }
    },
  });
  try {
    await scorer.submit("r1", [10, 10, 10]);
    await scorer.submit("r2", [1, 2, 3]);

    const result = await scorer.recalculate(2, V2);
    assert.equal(result, "published");

    // 回算期间的读取：仍为版本1，且包含新响应（按版本1权重打分）
    assert.ok(midRead);
    assert.equal(midRead.revision, 1);
    assert.deepEqual(
      midRead.scores.find((s) => s.id === "r_new"),
      { id: "r_new", score: (2 * 50 + 4 * 30 + 6 * 20) / 100 },
    );

    // 版本2发布后：回算期间新增的响应也有版本2的分数
    const after = await scorer.readScores(["r1", "r2", "r_new"]);
    assert.equal(after.revision, 2);
    assert.deepEqual(after.scores.find((s) => s.id === "r_new"), {
      id: "r_new",
      score: 6,
    });
    assert.deepEqual(after.scores.find((s) => s.id === "r1"), {
      id: "r1",
      score: 10,
    });
  } finally {
    scorer.close();
  }
});

test("版本3先登记并发布，版本2晚完成返回 superseded，版本与分数不倒退", async () => {
  let recalc3: Promise<"published" | "superseded"> | undefined;
  const scorer: Scorer = new Scorer({
    initialWeights: V1,
    onRecalculateBatch: async (info) => {
      // 版本2回算进行中登记版本3，并等版本3先完成发布
      if (info.revision === 2 && !recalc3) {
        recalc3 = scorer.recalculate(3, V3);
        assert.equal(await recalc3, "published");
      }
    },
  });
  try {
    await scorer.submit("a", [5, 5, 5]);
    await scorer.submit("b", [10, 1, 1]);

    const result2 = await scorer.recalculate(2, V2);
    assert.ok(recalc3);
    assert.equal(await recalc3, "published");
    assert.equal(result2, "superseded");

    // 当前发布版本为3，分数按版本3权重，且不倒退
    const scores = await scorer.readScores(["a", "b"]);
    assert.equal(scores.revision, 3);
    assert.deepEqual(scores.scores.find((s) => s.id === "a"), {
      id: "a",
      score: 5,
    });
    assert.deepEqual(scores.scores.find((s) => s.id === "b"), {
      id: "b",
      score: (10 * 10 + 1 * 10 + 1 * 80) / 100,
    });

    // 旧任务完成后再次读取，版本与分数保持不变
    const again = await scorer.readScores(["a", "b"]);
    assert.deepEqual(again, scores);
  } finally {
    scorer.close();
  }
});

test("基本流程与参数校验", async () => {
  const scorer = new Scorer({ initialWeights: V1 });
  try {
    await scorer.submit("x", [10, 10, 10]);
    const res = await scorer.readScores(["x", "missing"]);
    assert.equal(res.revision, 1);
    assert.deepEqual(res.scores, [{ id: "x", score: 10 }]);

    await assert.rejects(() => scorer.submit("bad", [0, 5, 5]));
    await assert.rejects(() => scorer.submit("bad", [1, 2] as never));
    await assert.rejects(() => scorer.recalculate(undefined, [50, 50, 50]));
    await assert.rejects(() => scorer.submit("x", [1, 1, 1])); // 重复 id

    // 版本号必须严格递增
    assert.equal(await scorer.recalculate(2, V2), "published");
    await assert.rejects(() => scorer.recalculate(2, V3));
    // 缺省时自动递增
    assert.equal(await scorer.recalculate(undefined, V3), "published");
    const after = await scorer.readScores(["x"]);
    assert.equal(after.revision, 3);
  } finally {
    scorer.close();
  }
});
