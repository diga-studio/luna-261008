/** SKU -> 数量 */
export type SkuQuantities = Record<string, number>;

/** 某原始订单贡献的一组 SKU 数量 */
export interface OrderContribution {
  orderId: string;
  quantities: SkuQuantities;
}

/** 拆分时一张新履约单的规格 */
export interface SplitSpec {
  locationId: string;
  lines: OrderContribution[];
}

/** 地点某 SKU 的库存配置 */
export interface SkuStockConfig {
  total: number;
  safetyStock: number;
}

/** 履约单状态 */
export type FulfillmentStatus = 'active' | 'inactive';

/** 履约单（执行单） */
export interface FulfillmentOrder {
  id: string;
  locationId: string;
  status: FulfillmentStatus;
  /** orderId -> (sku -> qty) */
  lines: Record<string, SkuQuantities>;
}

/** 地点配置 */
export interface LocationConfig {
  locationId: string;
  capacity: number;
  /** sku -> 库存配置 */
  inventory: Record<string, SkuStockConfig>;
}

/** 查询用快照：某地点的资源占用 */
export interface LocationUsage {
  locationId: string;
  /** 生效履约单数（容量占用） */
  activeFulfillments: number;
  capacity: number;
  /** sku -> 已预留数量 */
  reserved: SkuQuantities;
}

/** 操作结果 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
