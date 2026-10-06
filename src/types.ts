/** 三个固定数值指标，答案为 1 到 10 的整数。 */
export type Answers = [number, number, number];

/** 评分版本权重：三个非负整数，和为 100。 */
export type Weights = [number, number, number];

export type RecalculateResult = "published" | "superseded";

export interface ScoreEntry {
  id: string;
  score: number;
}

export interface ReadScoresResult {
  revision: number;
  scores: ScoreEntry[];
}
