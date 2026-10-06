import assert from "node:assert/strict";
import test from "node:test";
import { ChallengeService, SubmitInput } from "../src";
import { allCorrect, atDay, makeJourney } from "./helpers";

function dateOfJanuary(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}`;
}

test("两段各 6 天缺 1 天：补齐后 13 天奖 50XP，再增相邻一天 14 天奖 100XP；乱序重复投递 XP 守恒", () => {
  const service = new ChallengeService();
  try {
    const journey = makeJourney({ correctIndex: 0 });
    const { versionId } = service.publishChallengeVersion({ days: journey });
    const learner = "carol";

    // 挑战日序 i 对应活跃日期 2026-01-i
    const makeSubmit = (day: number): SubmitInput => ({
      learnerId: learner,
      day,
      versionId,
      answers: allCorrect(journey, day),
      occurredAt: atDay(dateOfJanuary(day)),
    });

    let xpGainedSum = 0;
    const submit = (day: number) => {
      const result = service.submitAnswer(makeSubmit(day));
      xpGainedSum += result.xpGained;
      return result;
    };

    // 第一段 6 天（1-6）与第二段 6 天（8-13），乱序投递，中间缺第 7 天
    const firstBatch = [3, 1, 9, 5, 13, 2, 8, 11, 4, 6, 12, 10];
    for (const day of firstBatch) {
      const result = submit(day);
      assert.equal(result.streakXpGained, 0, `day ${day} should not trigger streak reward yet`);
    }

    // 重复投递：返回原结果，本次新增 XP 为 0
    const dup = submit(3);
    assert.equal(dup.firstCompletion, false);
    assert.equal(dup.xpGained, 0);
    assert.equal(dup.completion.activeDate, dateOfJanuary(3));

    // 两段各 6 天，均不满 7 天，连续日奖励为 0
    let progress = service.getProgress(learner);
    assert.equal(progress.streakXp, 0);
    assert.equal(progress.activeDates.length, 12);
    assert.equal(progress.totalXp, 12 * 55);
    assert.equal(xpGainedSum, progress.totalXp);

    // 迟到记录补齐断档第 7 天：合并为 13 天连续段，奖励 50XP
    const fillGap = submit(7);
    assert.equal(fillGap.streakXpGained, 50);
    assert.equal(fillGap.xpGained, 55 + 50);
    progress = service.getProgress(learner);
    assert.equal(progress.streakXp, 50);
    assert.equal(progress.totalXp, 13 * 55 + 50);

    // 再增加相邻一天：14 天连续段，奖励 100XP，本次只补差额 50XP
    const day14 = submit(14);
    assert.equal(day14.streakXpGained, 50);
    progress = service.getProgress(learner);
    assert.equal(progress.streakXp, 100);
    assert.equal(progress.totalXp, 14 * 55 + 100);

    // 再乱序重复投递几次，均不增 XP
    for (const day of [14, 7, 1, 13]) {
      const result = submit(day);
      assert.equal(result.firstCompletion, false);
      assert.equal(result.xpGained, 0);
    }

    // 重复、乱序投递的本次新增 XP 之和必须等于最终累计 XP
    progress = service.getProgress(learner);
    assert.equal(progress.totalXp, 14 * 55 + 100);
    assert.equal(xpGainedSum, progress.totalXp);
    assert.equal(
      progress.totalXp,
      progress.completions.reduce((sum, c) => sum + c.baseXp, 0) + progress.streakXp,
    );
  } finally {
    service.close();
  }
});

test("同一天完成多个挑战只算一个活跃日，重试不制造新活跃日", () => {
  const service = new ChallengeService();
  try {
    const journey = makeJourney();
    const { versionId } = service.publishChallengeVersion({ days: journey });

    // 第 1、2 天的挑战在同一 UTC 自然日完成
    for (const day of [1, 2]) {
      service.submitAnswer({
        learnerId: "dave",
        day,
        versionId,
        answers: allCorrect(journey, day),
        occurredAt: atDay("2026-03-01"),
      });
    }
    // 用更晚的时间重试第 1 天，活跃日期不变
    const retry = service.submitAnswer({
      learnerId: "dave",
      day: 1,
      versionId,
      answers: allCorrect(journey, 1),
      occurredAt: atDay("2026-03-05"),
    });
    assert.equal(retry.xpGained, 0);
    assert.equal(retry.completion.activeDate, "2026-03-01");

    const progress = service.getProgress("dave");
    assert.deepEqual(progress.activeDates, ["2026-03-01"]);
    assert.equal(progress.totalXp, 2 * 55);
  } finally {
    service.close();
  }
});
