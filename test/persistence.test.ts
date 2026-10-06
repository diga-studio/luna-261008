import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChallengeService } from "../src";
import { allCorrect, atDay, makeJourney } from "./helpers";

test("挑战版本、完成记录和 XP 持久化到 SQLite 文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "challenge-"));
  const dbPath = join(dir, "challenge.db");
  try {
    const journey = makeJourney();
    let versionId: number;
    {
      const service = new ChallengeService({ dbPath });
      versionId = service.publishChallengeVersion({ days: journey }).versionId;
      for (let i = 1; i <= 7; i += 1) {
        service.submitAnswer({
          learnerId: "erin",
          day: i,
          versionId,
          answers: allCorrect(journey, i),
          occurredAt: atDay(`2026-04-0${i}`),
        });
      }
      service.close();
    }

    // 重新打开同一数据库文件：版本、完成记录、XP 全部保留
    {
      const service = new ChallengeService({ dbPath });
      const current = service.getCurrentChallenge(3);
      assert.equal(current.versionId, versionId);

      const progress = service.getProgress("erin");
      assert.equal(progress.completions.length, 7);
      assert.equal(progress.streakXp, 50);
      assert.equal(progress.totalXp, 7 * 55 + 50);

      // 重试仍命中历史完成记录，不增 XP
      const retry = service.submitAnswer({
        learnerId: "erin",
        day: 1,
        versionId,
        answers: allCorrect(journey, 1),
        occurredAt: atDay("2026-04-09"),
      });
      assert.equal(retry.firstCompletion, false);
      assert.equal(retry.xpGained, 0);
      service.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("异常路径：未发布版本、未知版本、非法日序", () => {
  const service = new ChallengeService();
  try {
    assert.throws(() => service.getCurrentChallenge(1), /no challenge version/);

    const journey = makeJourney();
    const { versionId } = service.publishChallengeVersion({ days: journey });
    assert.throws(() => service.getCurrentChallenge(0), /day must be/);
    assert.throws(() => service.getCurrentChallenge(91), /day must be/);
    assert.throws(
      () =>
        service.submitAnswer({
          learnerId: "frank",
          day: 1,
          versionId: versionId + 999,
          answers: allCorrect(journey, 1),
          occurredAt: atDay("2026-05-01"),
        }),
      /not found/,
    );
    assert.throws(
      () =>
        service.submitAnswer({
          learnerId: "frank",
          day: 1,
          versionId,
          answers: [0],
          occurredAt: atDay("2026-05-01"),
        }),
      /does not match/,
    );
  } finally {
    service.close();
  }
});
