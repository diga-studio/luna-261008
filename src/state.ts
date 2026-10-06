import type {
  FulfillmentOrderId,
  FulfillmentStatus,
  LocationConfig,
  LocationId,
  OriginalOrderId,
  OriginalOrderStatus,
  SkuId,
} from './types.js';

/** 内部履约单：lines 为 sku -> (orderId -> quantity)。 */
export interface FulfillmentOrder {
  id: FulfillmentOrderId;
  locationId: LocationId;
  status: FulfillmentStatus;
  lines: Map<SkuId, Map<OriginalOrderId, number>>;
}

export interface OriginalOrder {
  id: OriginalOrderId;
  status: OriginalOrderStatus;
  submitted: Map<SkuId, number>;
}

/** 全部业务状态（可整体序列化用于持久化）。 */
export interface State {
  locations: Map<LocationId, LocationConfig>;
  orders: Map<OriginalOrderId, OriginalOrder>;
  fulfillments: Map<FulfillmentOrderId, FulfillmentOrder>;
  nextFulfillmentSeq: number;
  /** 各地点资源占用的增量维护视图（不持久化，加载后由履约单重建）。 */
  usage: Map<LocationId, LocationUsage>;
  /** 原始订单 -> 当前包含其数量的生效履约单（不持久化，加载后重建）。 */
  orderIndex: Map<OriginalOrderId, Set<FulfillmentOrderId>>;
}

export function createEmptyState(): State {
  return {
    locations: new Map(),
    orders: new Map(),
    fulfillments: new Map(),
    nextFulfillmentSeq: 1,
    usage: new Map(),
    orderIndex: new Map(),
  };
}

export interface LocationUsage {
  /** sku -> 已预留数量 */
  reserved: Map<SkuId, number>;
  /** 生效履约单占用的名额数 */
  usedSlots: number;
}

/** 从全部生效履约单独立汇总各地点的库存预留与容量占用。 */
export function computeLocationUsage(state: State): Map<LocationId, LocationUsage> {
  const usage = new Map<LocationId, LocationUsage>();
  for (const locationId of state.locations.keys()) {
    usage.set(locationId, { reserved: new Map(), usedSlots: 0 });
  }
  for (const f of state.fulfillments.values()) {
    if (f.status !== 'active') continue;
    const u = usage.get(f.locationId);
    if (!u) continue;
    u.usedSlots += 1;
    for (const [sku, perOrder] of f.lines) {
      for (const qty of perOrder.values()) {
        u.reserved.set(sku, (u.reserved.get(sku) ?? 0) + qty);
      }
    }
  }
  return usage;
}

/** 重建增量维护的派生视图（加载持久化状态后调用）。 */
export function rebuildDerived(state: State): void {
  state.usage = computeLocationUsage(state);
  state.orderIndex = new Map();
  for (const f of state.fulfillments.values()) {
    if (f.status !== 'active') continue;
    for (const perOrder of f.lines.values()) {
      for (const orderId of perOrder.keys()) {
        let set = state.orderIndex.get(orderId);
        if (!set) {
          set = new Set();
          state.orderIndex.set(orderId, set);
        }
        set.add(f.id);
      }
    }
  }
}

/** 每个原始订单在所有生效履约单中的各 SKU 数量之和：orderId -> sku -> qty。 */
export function computeOrderTotals(state: State): Map<OriginalOrderId, Map<SkuId, number>> {
  const totals = new Map<OriginalOrderId, Map<SkuId, number>>();
  for (const f of state.fulfillments.values()) {
    if (f.status !== 'active') continue;
    for (const [sku, perOrder] of f.lines) {
      for (const [orderId, qty] of perOrder) {
        let perSku = totals.get(orderId);
        if (!perSku) {
          perSku = new Map();
          totals.set(orderId, perSku);
        }
        perSku.set(sku, (perSku.get(sku) ?? 0) + qty);
      }
    }
  }
  return totals;
}
