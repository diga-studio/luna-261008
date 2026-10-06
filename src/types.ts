/** 三个固定数值指标的答案，均为 1..10 的整数。 */
export type Answers = [number, number, number];

/** 评分版本的三个非负整数权重，和为 100。 */
export type Weights = [number, number, number];

/** recalculate 的最终结果。 */
export type RecalculateResult = "published" | "superseded";

/** readScores 的返回值。 */
export interface ScoresResult {
  /** 当前已发布的评分版本号。 */
  revision: number;
  /** 所请求响应的分数；缺失的 id 不出现在结果中。 */
  scores: Record<string, number>;
}
