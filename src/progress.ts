import type { DatabaseSync } from "node:sqlite";
import type { CompletionRecord, Progress } from "./types.js";

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

/** 查看学员进度：完成记录 + 累计 XP */
export function getProgress(db: DatabaseSync, learnerId: string): Progress {
  const rows = db
    .prepare(
      "SELECT * FROM completions WHERE learner_id = ? ORDER BY day",
    )
    .all(learnerId) as unknown as CompletionRow[];
  const completions: CompletionRecord[] = rows.map((row) => ({
    learnerId: row.learner_id,
    day: row.day,
    versionId: row.version_id,
    score: row.score,
    totalQuestions: row.total_questions,
    baseXp: row.base_xp,
    occurredAt: row.occurred_at,
    activeDate: row.active_date,
  }));
  const xpRow = db
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM xp_events WHERE learner_id = ?",
    )
    .get(learnerId) as { total: number };
  return { learnerId, completions, totalXp: xpRow.total };
}
