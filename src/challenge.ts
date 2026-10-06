import type { DatabaseSync } from "node:sqlite";
import type {
  CurrentChallenge,
  PublicDayChallenge,
  PublicQuestion,
  PublishInput,
} from "./types.js";

const JOURNEY_DAYS = 90;

function validateInput(input: PublishInput): void {
  if (input.days.length !== JOURNEY_DAYS) {
    throw new Error(`journey must contain exactly ${JOURNEY_DAYS} days`);
  }
  const seen = new Set<number>();
  for (const day of input.days) {
    if (!Number.isInteger(day.day) || day.day < 1 || day.day > JOURNEY_DAYS) {
      throw new Error(`invalid day: ${day.day}`);
    }
    if (seen.has(day.day)) {
      throw new Error(`duplicate day: ${day.day}`);
    }
    seen.add(day.day);
    if (day.questions.length === 0) {
      throw new Error(`day ${day.day} must have at least one question`);
    }
    for (const q of day.questions) {
      if (q.options.length < 2) {
        throw new Error(`question "${q.text}" needs at least two options`);
      }
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) {
        throw new Error(`question "${q.text}" has invalid correctIndex`);
      }
    }
  }
}

/** 发布一个新的挑战版本，返回版本标识 */
export function publishChallengeVersion(db: DatabaseSync, input: PublishInput): number {
  validateInput(input);
  db.exec("BEGIN");
  try {
    const result = db
      .prepare("INSERT INTO challenge_versions (created_at) VALUES (?)")
      .run(new Date().toISOString());
    const versionId = Number(result.lastInsertRowid);
    const insertQuestion = db.prepare(
      `INSERT INTO challenge_questions
       (version_id, day, question_index, text, options_json, correct_index)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const day of input.days) {
      day.questions.forEach((q, index) => {
        insertQuestion.run(
          versionId,
          day.day,
          index,
          q.text,
          JSON.stringify(q.options),
          q.correctIndex,
        );
      });
    }
    db.exec("COMMIT");
    return versionId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

interface QuestionRow {
  day: number;
  question_index: number;
  text: string;
  options_json: string;
}

/** 读取当前挑战（最新版本），带回版本标识 */
export function getCurrentChallenge(db: DatabaseSync): CurrentChallenge {
  const version = db
    .prepare("SELECT id FROM challenge_versions ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  if (!version) {
    throw new Error("no challenge version published yet");
  }
  const rows = db
    .prepare(
      `SELECT day, question_index, text, options_json
       FROM challenge_questions
       WHERE version_id = ?
       ORDER BY day, question_index`,
    )
    .all(version.id) as unknown as QuestionRow[];

  const byDay = new Map<number, PublicQuestion[]>();
  for (const row of rows) {
    let questions = byDay.get(row.day);
    if (!questions) {
      questions = [];
      byDay.set(row.day, questions);
    }
    questions.push({
      text: row.text,
      options: JSON.parse(row.options_json) as string[],
    });
  }
  const days: PublicDayChallenge[] = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, questions]) => ({ day, questions }));
  return { versionId: version.id, days };
}
