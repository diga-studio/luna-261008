/** SKU 标识，由调用方提供，库内不做格式假设。 */
export type SkuId = string;

/** 仓库标识，由调用方提供。 */
export type WarehouseId = string;

/** 一次等价组库存汇总的结果。 */
export interface GroupSummary {
  /** 组内不同 SKU 的数量。 */
  readonly skuCount: number;
  /** 各仓库的可用量总和（只包含当前总和非零的仓库）。 */
  readonly totals: ReadonlyMap<WarehouseId, number>;
}
