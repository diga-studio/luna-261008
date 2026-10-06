import { DatabaseSync } from "node:sqlite";
import { META_CURRENT_VERSION, openDatabase } from "./db";
import { computeStreakXp } from "./streak";
import {
  ChallengeView,
  CompletionRecord,
  DayChallenge,
  LearnerProgress,
  PublishChallengeInput,
  PublishResult,
  SubmitInput,
  SubmitResult,
} from "./types";

export const JOURNEY_DAYS = 90;
export const XP_PER_CORRECT = 10;
export const XP_COMPLETION_BONUS = 25;
export const STREAK_WINDOW_DAYS = 7;
export const STREAK_WINDOW_XP = 50;

export interface ChallengeServiceOptions {
  /** SQLite 文件路径，缺省为内存数据库 */
  dbPath?: string;
}

interface CompletionRow {
  learner_id: string;
  day: number;
  version_id: number;
  score: number;
  base_xp: number;
  active_date: string;
  occurred_at: string;
}

function toCompletionRecord(row: CompletionRow): CompletionRecord {
  return {
    learnerId: row.learner_id,
    day: row.day,
    versionId: row.version_id,
    score: row.score,
    baseXp: row.base_xp,
    activeDate: row.active_date,
    occurredAt: row.occurred_at,
  };
}

function toUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class ChallengeService {
  private readonly db: DatabaseSync;

  constructor(options: ChallengeServiceOptions = {}) {
    this.db = openDatabase(options.dbPath ?? ":memory:");
  }

  close(): void {
    this.db.close();
  }

  /** 发布挑战版本，返回版本标识 */
  publishChallengeVersion(input: PublishChallengeInput): PublishResult {
    validateJourney(input.days);
    const now = new Date().toISOString();
    const payload = JSON.stringify(input.days);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare("INSERT INTO challenge_versions (created_at, payload) VALUES (?, ?)")
        .run(now, payload);
      const versionId = Number(result.lastInsertRowid);
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(META_CURRENT_VERSION, String(versionId));
      this.db.exec("COMMIT");
      return { versionId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 读取当前版本下某一天的挑战（携带版本标识） */
  getCurrentChallenge(day: number): ChallengeView {
    assertDay(day);
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(META_CURRENT_VERSION) as { value: string } | undefined;
    if (!row) {
      throw new Error("no challenge version published yet");
    }
    const versionId = Number(row.value);
    const days = this.loadVersionDays(versionId);
    return { versionId, day, questions: findDay(days, day).questions };
  }

  /** 提交答题；重复提交返回原完成结果且新增 XP 为 0 */
  submitAnswer(input: SubmitInput): SubmitResult {
    if (!input || typeof input.learnerId !== "string" || input.learnerId.length === 0) {
      throw new Error("learnerId must be a non-empty string");
    }
    assertDay(input.day);
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
      throw new Error("occurredAt must be a valid Date");
    }
    if (!Array.isArray(input.answers)) {
      throw new Error("answers must be an array of option indices");
    }

    const days = this.loadVersionDays(input.versionId);
    const challenge = findDay(days, input.day);
    if (input.answers.length !== challenge.questions.length) {
      throw new Error(
        `answers length ${input.answers.length} does not match question count ${challenge.questions.length} for day ${input.day} in version ${input.versionId}`,
      );
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT * FROM completions WHERE learner_id = ? AND day = ?")
        .get(input.learnerId, input.day) as CompletionRow | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return {
          completion: toCompletionRecord(existing),
          xpGained: 0,
          streakXpGained: 0,
          firstCompletion: false,
        };
      }

      let score = 0;
      for (let i = 0; i < challenge.questions.length; i += 1) {
        if (input.answers[i] === challenge.questions[i].correctIndex) {
          score += 1;
        }
      }
      const baseXp = score * XP_PER_CORRECT + XP_COMPLETION_BONUS;
      const activeDate = toUtcDate(input.occurredAt);

      const streakBefore = this.currentStreakXp(input.learnerId);
      this.db
        .prepare(
          `INSERT INTO completions
             (learner_id, day, version_id, score, base_xp, active_date, occurred_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.learnerId,
          input.day,
          input.versionId,
          score,
          baseXp,
          activeDate,
          input.occurredAt.toISOString(),
          new Date().toISOString(),
        );
      const streakAfter = this.currentStreakXp(input.learnerId);
      const streakXpGained = streakAfter - streakBefore;

      const row = this.db
        .prepare("SELECT * FROM completions WHERE learner_id = ? AND day = ?")
        .get(input.learnerId, input.day) as unknown as CompletionRow;
      this.db.exec("COMMIT");
      return {
        completion: toCompletionRecord(row),
        xpGained: baseXp + streakXpGained,
        streakXpGained,
        firstCompletion: true,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 查看学员进度 */
  getProgress(learnerId: string): LearnerProgress {
    const rows = this.db
      .prepare("SELECT * FROM completions WHERE learner_id = ? ORDER BY day ASC")
      .all(learnerId) as unknown as CompletionRow[];
    const completions = rows.map(toCompletionRecord);
    const activeDates = this.listActiveDates(learnerId);
    const streakXp = computeStreakXp(activeDates, STREAK_WINDOW_DAYS, STREAK_WINDOW_XP);
    const baseXpTotal = completions.reduce((sum, c) => sum + c.baseXp, 0);
    return {
      learnerId,
      completions,
      totalXp: baseXpTotal + streakXp,
      streakXp,
      activeDates,
    };
  }

  private loadVersionDays(versionId: number): DayChallenge[] {
    if (!Number.isInteger(versionId)) {
      throw new Error("versionId must be an integer");
    }
    const row = this.db
      .prepare("SELECT payload FROM challenge_versions WHERE version_id = ?")
      .get(versionId) as { payload: string } | undefined;
    if (!row) {
      throw new Error(`challenge version ${versionId} not found`);
    }
    return JSON.parse(row.payload) as DayChallenge[];
  }

  private listActiveDates(learnerId: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT active_date FROM completions WHERE learner_id = ? ORDER BY active_date ASC")
      .all(learnerId) as unknown as { active_date: string }[];
    return rows.map((r) => r.active_date);
  }

  private currentStreakXp(learnerId: string): number {
    return computeStreakXp(this.listActiveDates(learnerId), STREAK_WINDOW_DAYS, STREAK_WINDOW_XP);
  }
}

function assertDay(day: number): void {
  if (!Number.isInteger(day) || day < 1 || day > JOURNEY_DAYS) {
    throw new Error(`day must be an integer between 1 and ${JOURNEY_DAYS}`);
  }
}

function findDay(days: DayChallenge[], day: number): DayChallenge {
  const found = days.find((d) => d.day === day);
  if (!found) {
    throw new Error(`day ${day} not found in challenge version`);
  }
  return found;
}

function validateJourney(days: DayChallenge[]): void {
  if (!Array.isArray(days) || days.length !== JOURNEY_DAYS) {
    throw new Error(`journey must contain exactly ${JOURNEY_DAYS} day challenges`);
  }
  const seen = new Set<number>();
  for (const dayChallenge of days) {
    assertDay(dayChallenge.day);
    if (seen.has(dayChallenge.day)) {
      throw new Error(`duplicate day ${dayChallenge.day} in journey`);
    }
    seen.add(dayChallenge.day);
    if (!Array.isArray(dayChallenge.questions) || dayChallenge.questions.length === 0) {
      throw new Error(`day ${dayChallenge.day} must contain at least one question`);
    }
    for (const question of dayChallenge.questions) {
      if (!Array.isArray(question.options) || question.options.length < 2) {
        throw new Error(`question ${question.id} on day ${dayChallenge.day} must have at least two options`);
      }
      if (
        !Number.isInteger(question.correctIndex) ||
        question.correctIndex < 0 ||
        question.correctIndex >= question.options.length
      ) {
        throw new Error(`question ${question.id} on day ${dayChallenge.day} has an invalid correctIndex`);
      }
    }
  }
}
