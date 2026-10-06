import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OnboardingChallenge,
  type PublishInput,
  type SubmitResult,
} from "../src/index.js";

/** 生成 90 天挑战，每天 questionsPerDay 道单选题，正确答案下标由 correctIndex 决定 */
function makeInput(correctIndex: number, questionsPerDay = 2): PublishInput {
  return {
    days: Array.from({ length: 90 }, (_, i) => ({
      day: i + 1,
      questions: Array.from({ length: questionsPerDay }, (_, q) => ({
        text: `Q${q}`,
        options: ["A", "B", "C", "D"],
        correctIndex,
      })),
    })),
  };
}

function withLib<T>(fn: (lib: OnboardingChallenge, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-"));
  const lib = new OnboardingChallenge(join(dir, "test.db"));
  try {
    return fn(lib, dir);
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("按旧版本答题后发布新版本：改题和重试均不改分、不增XP", () => {
  withLib((lib) => {
    const v1 = lib.publishChallengeVersion(makeInput(0));
    const first = lib.submitAnswers({
      learnerId: "L1",
      day: 5,
      versionId: v1,
      answers: [0, 0],
      occurredAt: new Date("2026-01-05T10:00:00Z"),
    });
    assert.equal(first.alreadyCompleted, false);
    assert.equal(first.completion.score, 2);
    assert.equal(first.completion.baseXp, 45);
    assert.equal(first.xpAwarded, 45);

    // 发布新版本：改题、改正确答案
    const v2 = lib.publishChallengeVersion(makeInput(1));
    const current = lib.getCurrentChallenge();
    assert.equal(current.versionId, v2);
    assert.equal(current.days.length, 90);

    // 用新版本、新答案、新时间重试同一天：返回原完成结果，不增 XP
    const retry = lib.submitAnswers({
      learnerId: "L1",
      day: 5,
      versionId: v2,
      answers: [1, 1],
      occurredAt: new Date("2026-02-01T10:00:00Z"),
    });
    assert.equal(retry.alreadyCompleted, true);
    assert.equal(retry.xpAwarded, 0);
    assert.equal(retry.completion.versionId, v1);
    assert.equal(retry.completion.score, 2);
    assert.equal(retry.completion.baseXp, 45);
    assert.equal(retry.completion.activeDate, "2026-01-05");

    // 新版本发布后，仍可按引用的旧版本计分
    const oldVersionSubmit = lib.submitAnswers({
      learnerId: "L1",
      day: 6,
      versionId: v1,
      answers: [0, 0],
      occurredAt: new Date("2026-01-06T10:00:00Z"),
    });
    assert.equal(oldVersionSubmit.completion.versionId, v1);
    assert.equal(oldVersionSubmit.completion.score, 2);

    // 若按新版本答案答旧版本的题，则按旧版本计分（答错）
    const scoredByV1 = lib.submitAnswers({
      learnerId: "L1",
      day: 7,
      versionId: v1,
      answers: [1, 1],
      occurredAt: new Date("2026-01-07T10:00:00Z"),
    });
    assert.equal(scoredByV1.completion.score, 0);
    assert.equal(scoredByV1.completion.baseXp, 25); // 全部答错也算完成

    const progress = lib.getProgress("L1");
    assert.equal(progress.totalXp, 45 + 45 + 25);
    assert.equal(progress.completions.length, 3);
  });
});

test("迟到记录补齐断档：13天奖励50XP，14天奖励100XP，乱序+重复投递XP守恒", () => {
  withLib((lib) => {
    const version = lib.publishChallengeVersion(makeInput(0, 1));
    const learner = "L2";
    // 活跃日期：两段各 6 天（01-01..01-06、01-08..01-13），缺 01-07
    const dates = [
      "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06",
      "2026-01-08", "2026-01-09", "2026-01-10", "2026-01-11", "2026-01-12", "2026-01-13",
    ];
    let awardedSum = 0;
    const submit = (day: number, date: string): SubmitResult => {
      const result = lib.submitAnswers({
        learnerId: learner,
        day,
        versionId: version,
        answers: [0],
        occurredAt: new Date(`${date}T08:00:00Z`),
      });
      awardedSum += result.xpAwarded;
      return result;
    };

    // 乱序首次投递前 12 天（中间缺 01-07）
    const order = [5, 2, 8, 0, 11, 3, 7, 1, 10, 4, 9, 6];
    for (const i of order) {
      const r = submit(i + 1, dates[i]);
      assert.equal(r.alreadyCompleted, false);
    }
    // 两段各 6 天，均不满 7 天，无连续日奖励
    assert.equal(lib.getProgress(learner).totalXp, 12 * 35);

    // 迟到的记录补齐断档：合并为 13 天连续段，奖励 50XP
    const fill = submit(13, "2026-01-07");
    assert.equal(fill.xpAwarded, 35 + 50);
    assert.equal(lib.getProgress(learner).totalXp, 13 * 35 + 50);

    // 再增加相邻一天：14 天连续段，奖励升为 100XP，本次只补差额 50
    const day14 = submit(14, "2026-01-14");
    assert.equal(day14.xpAwarded, 35 + 50);
    assert.equal(lib.getProgress(learner).totalXp, 14 * 35 + 100);

    // 重复、乱序投递全部历史提交：均返回原结果，新增 XP 为 0
    const allDates = [...dates.slice(0, 6), "2026-01-07", ...dates.slice(6), "2026-01-14"];
    const shuffled = [9, 3, 13, 0, 7, 12, 5, 1, 11, 8, 2, 10, 6, 4];
    for (const i of shuffled) {
      const r = submit(i + 1, allDates[i]);
      assert.equal(r.alreadyCompleted, true);
      assert.equal(r.xpAwarded, 0);
    }

    // 所有调用的本次新增 XP 之和 == 最终累计 XP
    const finalProgress = lib.getProgress(learner);
    assert.equal(finalProgress.totalXp, 14 * 35 + 100);
    assert.equal(awardedSum, finalProgress.totalXp);
  });
});

test("同一天完成多个挑战只算一个活跃日，重试不制造新活跃日", () => {
  withLib((lib) => {
    const version = lib.publishChallengeVersion(makeInput(0, 1));
    const learner = "L3";
    // 6 个挑战分布在 3 个 UTC 自然日
    for (let i = 0; i < 6; i++) {
      lib.submitAnswers({
        learnerId: learner,
        day: i + 1,
        versionId: version,
        answers: [0],
        occurredAt: new Date(`2026-03-0${1 + (i % 3)}T12:00:00Z`),
      });
    }
    // 只有 3 个活跃日，无连续奖励
    assert.equal(lib.getProgress(learner).totalXp, 6 * 35);
    // 再完成 4 天凑满 7 个连续活跃日
    for (let i = 0; i < 4; i++) {
      lib.submitAnswers({
        learnerId: learner,
        day: 7 + i,
        versionId: version,
        answers: [0],
        occurredAt: new Date(`2026-03-0${4 + i}T12:00:00Z`),
      });
    }
    assert.equal(lib.getProgress(learner).totalXp, 10 * 35 + 50);
  });
});

test("活跃日期取首次完成时间的UTC自然日", () => {
  withLib((lib) => {
    const version = lib.publishChallengeVersion(makeInput(0, 1));
    const r = lib.submitAnswers({
      learnerId: "L4",
      day: 1,
      versionId: version,
      answers: [0],
      occurredAt: new Date("2026-01-02T01:30:00+05:00"), // UTC 2026-01-01 20:30
    });
    assert.equal(r.completion.activeDate, "2026-01-01");
  });
});

test("进度持久化到SQLite，重开后不丢失", () => {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-"));
  const dbPath = join(dir, "persist.db");
  try {
    const lib = new OnboardingChallenge(dbPath);
    const version = lib.publishChallengeVersion(makeInput(0, 1));
    lib.submitAnswers({
      learnerId: "L5",
      day: 1,
      versionId: version,
      answers: [0],
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    lib.close();

    const reopened = new OnboardingChallenge(dbPath);
    const progress = reopened.getProgress("L5");
    assert.equal(progress.totalXp, 35);
    assert.equal(progress.completions.length, 1);
    assert.equal(progress.completions[0].versionId, version);
    assert.equal(reopened.getCurrentChallenge().versionId, version);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未发布版本时读取当前挑战报错；非法入参报错", () => {
  withLib((lib) => {
    assert.throws(() => lib.getCurrentChallenge(), /no challenge version/);
    const version = lib.publishChallengeVersion(makeInput(0, 1));
    assert.throws(
      () =>
        lib.submitAnswers({
          learnerId: "L6",
          day: 1,
          versionId: version,
          answers: [0, 1],
          occurredAt: new Date(),
        }),
      /expected 1 answers/,
    );
    assert.throws(
      () =>
        lib.submitAnswers({
          learnerId: "L6",
          day: 1,
          versionId: 999,
          answers: [0],
          occurredAt: new Date(),
        }),
      /no challenge for day/,
    );
  });
});
