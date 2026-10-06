/** 单笔收入的录入/修订输入。金额单位：分。 */
export interface RevenueInput {
  /** 全局唯一正整数编号 */
  id: bigint;
  contractId: string;
  product: string;
  /** UTC 业务日期，格式 YYYY-MM-DD */
  bizDate: string;
  /** 收入金额，正整数分 */
  amountCents: bigint;
  /** 直接成本，非负整数分 */
  directCostCents: bigint;
}

/** 单个合同在查询区间内的利润汇总。 */
export interface ContractProfit {
  contractId: string;
  revenueCents: bigint;
  directCostCents: bigint;
  allocatedFixedCostCents: bigint;
  netProfitCents: bigint;
}

/** 成本池键：一个产品的一个 UTC 自然月。 */
export interface PoolKey {
  product: string;
  /** YYYY-MM */
  month: string;
}
