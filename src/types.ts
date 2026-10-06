/** 维度值映射：标签名 -> 整数（以 0.01 分为单位）。空映射表示撤销整条评级。 */
export type DimensionValues = Record<string, number>;

/** 维度权重配置：标签名 -> 权重。 */
export type Weights = Record<string, number>;

export interface CreditResult {
  /** 当前信用分（未舍入）。 */
  score: number;
  /** 是否限制邀评：未舍入信用分严格小于 40。 */
  restricted: boolean;
}
