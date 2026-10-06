/** 查询结果：等价组的 SKU 数量与各仓库可用量汇总。 */
export interface GroupSummary {
  /** 组内不同 SKU 的数量 */
  skuCount: number;
  /** 各仓库可用量总和，键为仓库标识 */
  stock: Record<string, number>;
}

/** 组件内部使用的等价组记录。 */
export interface ComponentInfo {
  /** 组内 SKU 数量 */
  size: number;
  /** 组级库存汇总：内部仓库编号 -> 可用量总和 */
  stock: Map<number, number>;
}
