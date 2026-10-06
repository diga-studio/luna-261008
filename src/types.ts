/** 成交类型：新业务 / 续约 */
export type DealType = "newBusiness" | "renewal";

/** 阶梯档位。thresholdCents 为该档起点的累计金额（分），首档必须为 "0"。 */
export interface Tier {
  readonly thresholdCents: string;
  readonly rateBps: number;
}

/** 不可变计划版本，生效区间为 [startDate, endDate]（MM/DD/YYYY，含端点）。 */
export interface PlanVersion {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly newBusinessTiers: readonly Tier[];
  readonly renewalTiers: readonly Tier[];
}

/** 成交记录。amountCents 为十进制整数字符串（分），closeDate 为 MM/DD/YYYY。 */
export interface Deal {
  readonly externalId: string;
  readonly amountCents: string;
  readonly closeDate: string;
  readonly dealType: DealType;
}

/** 单个计费切片：累计区间 [fromCumulativeCents, toCumulativeCents)，左闭右开。 */
export interface CommissionSlice {
  readonly fromCumulativeCents: string;
  readonly toCumulativeCents: string;
  readonly amountCents: string;
  readonly rateBps: number;
}

/** ExplainDeal 的返回结果，所有金额均为十进制整数字符串（分）。 */
export interface DealExplanation {
  readonly externalId: string;
  readonly priorCumulativeCents: string;
  readonly planVersionId: string;
  readonly slices: readonly CommissionSlice[];
  readonly payableCents: string;
}
