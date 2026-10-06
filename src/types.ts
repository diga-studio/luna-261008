/** 一笔收入的录入/修订内容。金额单位为分，均为整数。 */
export interface RevenueInput {
  /** 全局唯一正整数编号 */
  id: number | bigint;
  /** 合同编号 */
  contractId: number | bigint;
  /** 产品编号 */
  productId: number | bigint;
  /** UTC 业务日期，格式 YYYY-MM-DD */
  bizDate: string;
  /** 收入金额（分），正整数 */
  amount: number | bigint;
  /** 直接成本（分），非负整数 */
  directCost: number | bigint;
}

/** 按合同聚合的利润查询结果。金额单位为分，使用 bigint 保证精确到分。 */
export interface ContractProfit {
  contractId: bigint;
  revenue: bigint;
  directCost: bigint;
  allocatedFixedCost: bigint;
  /** revenue - directCost - allocatedFixedCost，允许为负 */
  netProfit: bigint;
}

/** 查询区间：[from, to)，UTC 日期 YYYY-MM-DD */
export interface DateRange {
  from: string;
  to: string;
}
