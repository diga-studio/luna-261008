/** 评价维度 */
export type Dimension = 'manager' | 'peer' | 'self';

/** 维度固定权重 */
export const DIMENSION_WEIGHTS: Readonly<Record<Dimension, number>> = {
  manager: 50,
  peer: 30,
  self: 20,
};

/** 模板树节点：叶子带原始分上下界，内部节点带加权子节点 */
export type TemplateNode =
  | { kind: 'leaf'; id: string; min: number; max: number }
  | { kind: 'internal'; id: string; children: { node: TemplateNode; weight: number }[] };

/** 一条评分记录（叶子指标 × 维度 × 评价人） */
export interface Rating {
  metricId: string;
  dimension: Dimension;
  evaluatorId: string;
  score: number;
}

/** read 探针：指定一个评分三元组 */
export interface Probe {
  metricId: string;
  dimension: Dimension;
  evaluatorId: string;
}

/** read 返回值：根分数 + 可选的贡献系数 */
export interface ReadResult {
  /** 根节点当前分数；无有效评分时为 null */
  root: number | null;
  /** probe 指定记录的有效系数；记录不存在或被回避时为 0 */
  coefficient?: number;
}

/** 引擎实例：模板在生命周期内固定 */
export interface Engine {
  setRating(
    metricId: string,
    dimension: Dimension,
    evaluatorId: string,
    scoreOrNull: number | null,
  ): void;
  setRecused(evaluatorId: string, recused: boolean): void;
  read(probe?: Probe): ReadResult;
}
