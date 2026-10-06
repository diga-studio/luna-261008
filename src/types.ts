/** 购物车中的一行：同一 SKU 只有一行 */
export interface CartLine {
  sku: string;
  /** 原价，整数美分 */
  unitPriceCents: number;
  /** 购买份数，正整数 */
  quantity: number;
}

/** 买 X 赠 Y 活动 */
export interface BuyXGetYActivity {
  kind: 'buyXGetY';
  id: string;
  /** 门槛品 SKU 集合 */
  thresholdSkus: readonly string[];
  /** 赠品 SKU 集合 */
  giftSkus: readonly string[];
  /** 门槛份数，正整数 */
  x: number;
  /** 赠品份数，正整数 */
  y: number;
}

/** 整单百分比优惠，percentOff 为 1~50 的整数（表示减免百分之几） */
export interface PercentOffActivity {
  kind: 'percentOff';
  id: string;
  percentOff: number;
}

/** 固定美分减免 */
export interface FixedOffActivity {
  kind: 'fixedOff';
  id: string;
  amountOffCents: number;
}

export type Activity = BuyXGetYActivity | PercentOffActivity | FixedOffActivity;

export interface QuoteRequest {
  cart: readonly CartLine[];
  /** 当前可用的活动（由上层确认可用） */
  activities: readonly Activity[];
  /** 明确允许互相叠加的活动 id 对；不在列表中的两个活动不可同时使用 */
  stackablePairs: readonly (readonly [string, string])[];
}

/** 某个买赠活动按 SKU 的分配结果 */
export interface BuyXGetYAllocation {
  activityId: string;
  /** 门槛品：sku -> 份数，合计恰为 X */
  thresholds: Record<string, number>;
  /** 赠品：sku -> 份数，合计恰为 Y */
  gifts: Record<string, number>;
}

export interface QuoteResult {
  /** 最低应付金额，整数美分，最低为 0 */
  payableCents: number;
  /** 选中的活动 id（0~2 个） */
  selectedActivityIds: string[];
  /** 每个选中买赠活动的分配方案 */
  allocations: BuyXGetYAllocation[];
}
