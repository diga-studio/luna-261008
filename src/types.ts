/** 档位：门槛（分，十进制整数字符串）与费率（基点，10000 = 100%）。 */
export interface Tier {
  readonly thresholdCents: string;
  readonly rateBps: number;
}

/** 计划版本：生效区间 [effectiveFrom, effectiveTo]，日期 MM/DD/YYYY，闭区间。 */
export interface PlanVersion {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly newBusinessTiers: readonly Tier[];
  readonly renewalTiers: readonly Tier[];
}

export type DealType = "NEW_BUSINESS" | "RENEWAL";

export interface DealInput {
  readonly externalId: string;
  readonly amountCents: string;
  readonly closeDate: string; // MM/DD/YYYY
  readonly dealType: DealType;
}

/** 跨档切片：累计区间 [fromCents, toCents)，分摊金额与费率。 */
export interface CommissionSlice {
  readonly fromCents: string;
  readonly toCents: string;
  readonly amountCents: string;
  readonly rateBps: number;
}

export interface CommissionExplanation {
  readonly externalId: string;
  readonly priorAccumulatedCents: string;
  readonly planVersionId: string;
  readonly slices: readonly CommissionSlice[];
  readonly paymentCents: string;
}
