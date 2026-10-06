import type { DatabaseSync } from "node:sqlite";
import type { CompletionRecord, SubmitInput, SubmitResult } from "./types.js";

const XP_PER_CORRECT = 10;
const XP_PER_COMPLETION = 25;
const STREAK_WINDOW_DAYS = 7;
const STREAK_WINDOW_XP = 50;

interface CompletionRow {
  learner_id: string;
  day: number;
  version_id: number;
  score: number;
  total_questions: number;
  base_xp: number;
  occurred_at: string;
  active_date: string;
}

interface QuestionRow {
  question_index: number;
  correct_index: number;
}

function toRecord(row: CompletionRow): CompletionRecord {
  return {
    learnerId: row.learner_id,
    day: row.day,
    versionId: row.version_id,
    score: row.score,
    totalQuestions: row.total_questions,
    baseXp: row.base_xp,
    occurredAt: row.occurred_at,
    activeDate: row.active_date,
  };
}

function utcDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayNumberOf(utcDate: string): number {
  return Date.parse(`${utcDate}T00:00:00.000Z`) / 86_400_000;
}

/** 将活跃日期划分为最大连续段，每段每满 7 天奖励 50XP */
export function streakXpFor(activeDates: string[]): number {
  const sorted = [...activeDates].sort();
  let total = 0;
  let runLength = 0;
  let previous: number | null = null;
  for (const date of sorted) {
    const dayNumber = dayNumberOf(date);
    runLength = previous !== null && dayNumber === previous + 1 ? runLength + 1 : 1;
    if (runLength % STREAK_WINDOW_DAYS === 0) {
      total += STREAK_WINDOW_XP;
    }
    previous = dayNumber;
  }
  return total;
}

function totalStreakXpAwarded(db: DatabaseSync, learnerId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM xp_events WHERE learner_id = ? AND kind = 'streak'`,
    )
    .get(learnerId) as { total: number };
  return row.total;
}

/** 提交答题：幂等结算，重复/迟到提交返回原结果 */
export function submitAnswers(db: DatabaseSync, input: SubmitInput): SubmitResult {
  const { learnerId, day, versionId, answers, occurredAt } = input;
  if (!Number.isInteger(day) || day < 1 || day > 90) {
    throw new Error(`invalid day: ${day}`);
  }
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
    throw new Error("occurredAt must be a valid Date");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT * FROM completions WHERE learner_id = ? AND day = ?")
      .get(learnerId, day) as CompletionRow | undefined;
    if (existing) {
      db.exec("COMMIT");
      return { completion: toRecord(existing), xpAwarded: 0, alreadyCompleted: true };
    }

    const questions = db
      .prepare(
        `SELECT question_index, correct_index
         FROM challenge_questions
         WHERE version_id = ? AND day = ?
         ORDER BY question_index`,
      )
      .all(versionId, day) as unknown as QuestionRow[];
    if (questions.length === 0) {
      throw new Error(`version ${versionId} has no challenge for day ${day}`);
    }
    if (answers.length !== questions.length) {
      throw new Error(
        `expected ${questions.length} answers, got ${answers.length}`,
      );
    }

    let score = 0;
    for (const q of questions) {
      if (answers[q.question_index] === q.correct_index) {
        score += 1;
      }
    }
    const baseXp = score * XP_PER_CORRECT + XP_PER_COMPLETION;
    const activeDate = utcDateOf(occurredAt);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO completions
       (learner_id, day, version_id, score, total_questions, base_xp, occurred_at, active_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      learnerId,
      day,
      versionId,
      score,
      questions.length,
      baseXp,
      occurredAt.toISOString(),
      activeDate,
      now,
    );
    db.prepare(
      `INSERT INTO xp_events (learner_id, kind, amount, day, created_at)
       VALUES (?, 'base', ?, ?, ?)`,
    ).run(learnerId, baseXp, day, now);
    db.prepare(
      "INSERT OR IGNORE INTO active_days (learner_id, active_date) VALUES (?, ?)",
    ).run(learnerId, activeDate);

    const activeDates = (
      db
        .prepare("SELECT active_date FROM active_days WHERE learner_id = ?")
        .all(learnerId) as unknown as { active_date: string }[]
    ).map((r) => r.active_date);
    const deserved = streakXpFor(activeDates);
    const alreadyAwarded = totalStreakXpAwarded(db, learnerId);
    const streakDelta = deserved - alreadyAwarded;
    if (streakDelta > 0) {
      db.prepare(
        `INSERT INTO xp_events (learner_id, kind, amount, day, created_at)
         VALUES (?, 'streak', ?, NULL, ?)`,
      ).run(learnerId, streakDelta, now);
    }

    const completion = db
      .prepare("SELECT * FROM completions WHERE learner_id = ? AND day = ?")
      .get(learnerId, day) as unknown as CompletionRow;
    db.exec("COMMIT");
    return {
      completion: toRecord(completion),
      xpAwarded: baseXp + Math.max(streakDelta, 0),
      alreadyCompleted: false,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
