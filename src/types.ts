/** 评价维度 */
export type Dimension = 'manager' | 'peer' | 'self';

/** 维度固定权重 */
export const DIMENSION_WEIGHTS: Readonly<Record<Dimension, number>> = {
  manager: 50,
  peer: 30,
  self: 20,
};

/** 叶子指标节点：定义原始分数上下界 */
export interface LeafNode {
  id: string;
  min: number;
  max: number;
}

/** 内部维度节点：通过带权边连接子节点 */
export interface InternalNode {
  id: string;
  children: Array<{ node: TemplateNode; weight: number }>;
}

export type TemplateNode = LeafNode | InternalNode;

export function isLeaf(node: TemplateNode): node is LeafNode {
  return !('children' in node);
}

/** 一条评分记录：叶子指标 × 维度 × 评价人 */
export interface Rating {
  metricId: string;
  dimension: Dimension;
  evaluatorId: string;
  /** 原始分数（未归一化） */
  score: number;
}

/** read() 的探针：指定一个评分三元组 */
export interface Probe {
  metricId: string;
  dimension: Dimension;
  evaluatorId: string;
}

/** read() 的返回值 */
export interface ReadResult {
  /** 当前根分数；没有任何有效评分时为 null */
  rootScore: number | null;
  /**
   * 当 probe 指定时返回该评分的有效系数：
   * 当前聚合表达式中该记录归一化分数所乘的因子。
   * 记录不存在或被回避时系数为 0。
   */
  coefficient?: number;
}

/** 评分引擎实例 */
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
