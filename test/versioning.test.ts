import assert from "node:assert/strict";
import test from "node:test";
import { ChallengeService } from "../src";
import { allCorrect, allWrong, atDay, makeJourney } from "./helpers";

test("按旧版本答题后发布新版本：改题和重试均不改分、不增 XP", () => {
  const service = new ChallengeService();
  try {
    const journeyV1 = makeJourney({ correctIndex: 0 });
    const { versionId: v1 } = service.publishChallengeVersion({ days: journeyV1 });

    // 学员在 v1 下完成第 5 天，全部答对
    const first = service.submitAnswer({
      learnerId: "alice",
      day: 5,
      versionId: v1,
      answers: allCorrect(journeyV1, 5),
      occurredAt: atDay("2026-01-10"),
    });
    assert.equal(first.firstCompletion, true);
    assert.equal(first.completion.versionId, v1);
    assert.equal(first.completion.score, 3);
    assert.equal(first.completion.baseXp, 3 * 10 + 25);
    assert.equal(first.completion.activeDate, "2026-01-10");
    assert.equal(first.xpGained, 55);

    // 发布 v2：改题、改正确答案
    const journeyV2 = makeJourney({ correctIndex: 1 });
    const { versionId: v2 } = service.publishChallengeVersion({ days: journeyV2 });
    assert.notEqual(v2, v1);

    // 读取当前挑战必须带回新版本标识
    const current = service.getCurrentChallenge(5);
    assert.equal(current.versionId, v2);
    assert.equal(current.day, 5);
    assert.equal(current.questions[0].correctIndex, 1);

    const progressBefore = service.getProgress("alice");
    assert.equal(progressBefore.totalXp, 55);

    // 重试：换版本、换答案、换提交时间，都返回原完成结果且不增 XP
    const retryNewVersion = service.submitAnswer({
      learnerId: "alice",
      day: 5,
      versionId: v2,
      answers: allCorrect(journeyV2, 5),
      occurredAt: atDay("2026-01-11"),
    });
    assert.equal(retryNewVersion.firstCompletion, false);
    assert.deepEqual(retryNewVersion.completion, first.completion);
    assert.equal(retryNewVersion.xpGained, 0);

    const retryWrong = service.submitAnswer({
      learnerId: "alice",
      day: 5,
      versionId: v1,
      answers: allWrong(journeyV1, 5),
      occurredAt: atDay("2026-01-09"),
    });
    assert.equal(retryWrong.firstCompletion, false);
    assert.deepEqual(retryWrong.completion, first.completion);
    assert.equal(retryWrong.xpGained, 0);

    // 历史成绩未被改写，累计 XP 不变
    const progressAfter = service.getProgress("alice");
    assert.equal(progressAfter.totalXp, 55);
    assert.equal(progressAfter.completions.length, 1);
    assert.deepEqual(progressAfter.completions[0], first.completion);

    // 新的一天仍可显式引用旧版本 v1，并按 v1 计分
    // （v1 下全对的答案在 v2 下全错，得分证明按引用版本计分）
    const day6 = service.submitAnswer({
      learnerId: "alice",
      day: 6,
      versionId: v1,
      answers: allCorrect(journeyV1, 6),
      occurredAt: atDay("2026-01-11"),
    });
    assert.equal(day6.completion.versionId, v1);
    assert.equal(day6.completion.score, 3);
    assert.equal(day6.completion.baseXp, 55);
  } finally {
    service.close();
  }
});

test("全部答错也算完成，只获得完成奖励", () => {
  const service = new ChallengeService();
  try {
    const journey = makeJourney();
    const { versionId } = service.publishChallengeVersion({ days: journey });
    const result = service.submitAnswer({
      learnerId: "bob",
      day: 1,
      versionId,
      answers: allWrong(journey, 1),
      occurredAt: atDay("2026-02-01"),
    });
    assert.equal(result.completion.score, 0);
    assert.equal(result.completion.baseXp, 25);
    assert.equal(result.xpGained, 25);
    assert.equal(service.getProgress("bob").totalXp, 25);
  } finally {
    service.close();
  }
});
