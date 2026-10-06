export type LocationId = string;
export type SkuId = string;
export type OriginalOrderId = string;
export type FulfillmentOrderId = string;

/** 一个 SKU 在某履约单中、归属于某个原始订单的数量。 */
export interface OrderSkuQuantity {
  orderId: OriginalOrderId;
  sku: SkuId;
  quantity: number;
}

/** 提交原始订单时的行项目。 */
export interface OrderLine {
  sku: SkuId;
  quantity: number;
}

/** 拆分目标：一张新履约单的地点及其按原始订单归属的数量明细。 */
export interface SplitTargetSpec {
  locationId: LocationId;
  lines: OrderSkuQuantity[];
}

/** 地点配置：每个 SKU 的库存总量与安全库存，以及地点容量（生效履约单名额数）。 */
export interface LocationConfig {
  capacity: number;
  skus: Record<SkuId, SkuStockConfig>;
}

export interface SkuStockConfig {
  total: number;
  safetyStock: number;
}

export type FulfillmentStatus = 'active' | 'inactive';
export type OriginalOrderStatus = 'active' | 'cancelled';

/** 履约单快照（对外只读视图）。 */
export interface FulfillmentOrderView {
  id: FulfillmentOrderId;
  locationId: LocationId;
  status: FulfillmentStatus;
  /** sku -> (orderId -> quantity) */
  lines: ReadonlyMap<SkuId, ReadonlyMap<OriginalOrderId, number>>;
}

/** 原始订单快照（对外只读视图）。 */
export interface OriginalOrderView {
  id: OriginalOrderId;
  status: OriginalOrderStatus;
  /** 提交时的数量：sku -> quantity */
  submitted: ReadonlyMap<SkuId, number>;
}

/** 某地点某 SKU 的库存视图。 */
export interface LocationSkuView {
  total: number;
  safetyStock: number;
  reserved: number;
  available: number;
}

/** 某地点的容量视图。 */
export interface LocationCapacityView {
  capacity: number;
  used: number;
  available: number;
}
