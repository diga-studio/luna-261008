import { StoreError } from './errors.js';
import { FilePersistence } from './persistence.js';
import type { FulfillmentOrder, LocationUsage, State } from './state.js';
import type {
  FulfillmentOrderId,
  FulfillmentOrderView,
  LocationCapacityView,
  LocationConfig,
  LocationId,
  LocationSkuView,
  OrderLine,
  OriginalOrderId,
  OriginalOrderView,
  SkuId,
  SplitTargetSpec,
} from './types.js';

export interface OrderInventoryStoreOptions {
  /** 本地持久化文件路径（JSON，原子写）。 */
  filePath: string;
}

function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StoreError('INVALID_ARGUMENT', `${what} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new StoreError('INVALID_ARGUMENT', `${what} must be a non-negative integer, got ${value}`);
  }
}

function addQuantity(
  lines: Map<SkuId, Map<OriginalOrderId, number>>,
  sku: SkuId,
  orderId: OriginalOrderId,
  quantity: number,
): void {
  let perOrder = lines.get(sku);
  if (!perOrder) {
    perOrder = new Map();
    lines.set(sku, perOrder);
  }
  perOrder.set(orderId, (perOrder.get(orderId) ?? 0) + quantity);
}

function linesEqual(
  a: Map<SkuId, Map<OriginalOrderId, number>>,
  b: Map<SkuId, Map<OriginalOrderId, number>>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [sku, perOrderA] of a) {
    const perOrderB = b.get(sku);
    if (!perOrderB || perOrderB.size !== perOrderA.size) return false;
    for (const [orderId, qty] of perOrderA) {
      if (perOrderB.get(orderId) !== qty) return false;
    }
  }
  return true;
}

export class OrderInventoryStore {
  private readonly state: State;
  private readonly persistence: FilePersistence;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private dirty = false;

  private constructor(state: State, persistence: FilePersistence) {
    this.state = state;
    this.persistence = persistence;
  }

  static open(options: OrderInventoryStoreOptions): OrderInventoryStore {
    const persistence = new FilePersistence(options.filePath);
    const state = persistence.load();
    return new OrderInventoryStore(state, persistence);
  }

  /** 串行化所有变更操作；操作在内存中同步应用，失败时不留任何变更。 */
  private enqueue<T>(fn: () => T): Promise<T> {
    if (this.closed) {
      return Promise.reject(new StoreError('STORE_CLOSED', 'store is closed'));
    }
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireLocation(locationId: LocationId): LocationConfig {
    const config = this.state.locations.get(locationId);
    if (!config) {
      throw new StoreError('LOCATION_NOT_FOUND', `unknown location: ${locationId}`);
    }
    return config;
  }

  private requireActiveFulfillment(id: FulfillmentOrderId): FulfillmentOrder {
    const f = this.state.fulfillments.get(id);
    if (!f) {
      throw new StoreError('FULFILLMENT_NOT_FOUND', `unknown fulfillment order: ${id}`);
    }
    if (f.status !== 'active') {
      throw new StoreError('FULFILLMENT_NOT_ACTIVE', `fulfillment order is not active: ${id}`);
    }
    return f;
  }

  private usageOf(locationId: LocationId): LocationUsage {
    let u = this.state.usage.get(locationId);
    if (!u) {
      u = { reserved: new Map(), usedSlots: 0 };
      this.state.usage.set(locationId, u);
    }
    return u;
  }

  /** 把一张生效履约单的整体占用计入（sign=1）或移出（sign=-1）资源视图。 */
  private applyUsage(f: FulfillmentOrder, sign: 1 | -1): void {
    const u = this.usageOf(f.locationId);
    u.usedSlots += sign;
    for (const [sku, perOrder] of f.lines) {
      for (const qty of perOrder.values()) {
        this.addSkuUsage(u, sku, sign * qty);
      }
    }
  }

  private addSkuUsage(u: LocationUsage, sku: SkuId, delta: number): void {
    const next = (u.reserved.get(sku) ?? 0) + delta;
    if (next === 0) {
      u.reserved.delete(sku);
    } else {
      u.reserved.set(sku, next);
    }
  }

  /**
   * 按“操作完成后”的状态校验库存与容量：先移除 inputs 的占用，再加上 outputs 的占用。
   * 原预留参与重新核算，因此同地点原地拆并不会因输入单自身占满库存而失败。
   * 只检查受影响的地点，复杂度与本次操作涉及的单据规模成正比。
   */
  private checkResourcesAfter(remove: FulfillmentOrder[], add: FulfillmentOrder[]): void {
    const deltas = new Map<LocationId, { slots: number; reserved: Map<SkuId, number> }>();
    const accumulate = (f: FulfillmentOrder, sign: 1 | -1) => {
      let d = deltas.get(f.locationId);
      if (!d) {
        d = { slots: 0, reserved: new Map() };
        deltas.set(f.locationId, d);
      }
      d.slots += sign;
      for (const [sku, perOrder] of f.lines) {
        for (const qty of perOrder.values()) {
          d.reserved.set(sku, (d.reserved.get(sku) ?? 0) + sign * qty);
        }
      }
    };
    for (const f of remove) accumulate(f, -1);
    for (const f of add) accumulate(f, 1);
    for (const [locationId, d] of deltas) {
      const config = this.state.locations.get(locationId);
      if (!config) {
        throw new StoreError('LOCATION_NOT_FOUND', `unknown location: ${locationId}`);
      }
      const u = this.usageOf(locationId);
      if (u.usedSlots + d.slots > config.capacity) {
        throw new StoreError(
          'INSUFFICIENT_CAPACITY',
          `location ${locationId} capacity exceeded: ${u.usedSlots + d.slots} > ${config.capacity}`,
        );
      }
      for (const [sku, delta] of d.reserved) {
        const reserved = (u.reserved.get(sku) ?? 0) + delta;
        const skuConfig = config.skus[sku];
        const limit = (skuConfig?.total ?? 0) - (skuConfig?.safetyStock ?? 0);
        if (reserved > limit) {
          throw new StoreError(
            'INSUFFICIENT_STOCK',
            `location ${locationId} sku ${sku} stock exceeded: ${reserved} > ${limit}`,
          );
        }
      }
    }
  }

  private newFulfillment(locationId: LocationId, lines: Map<SkuId, Map<OriginalOrderId, number>>): FulfillmentOrder {
    const id = `F${this.state.nextFulfillmentSeq}`;
    const fulfillment: FulfillmentOrder = { id, locationId, status: 'active', lines };
    this.state.nextFulfillmentSeq += 1;
    this.state.fulfillments.set(id, fulfillment);
    this.applyUsage(fulfillment, 1);
    for (const perOrder of lines.values()) {
      for (const orderId of perOrder.keys()) {
        let set = this.state.orderIndex.get(orderId);
        if (!set) {
          set = new Set();
          this.state.orderIndex.set(orderId, set);
        }
        set.add(id);
      }
    }
    return fulfillment;
  }

  private deactivate(f: FulfillmentOrder): void {
    f.status = 'inactive';
    this.applyUsage(f, -1);
    for (const perOrder of f.lines.values()) {
      for (const orderId of perOrder.keys()) {
        const set = this.state.orderIndex.get(orderId);
        if (set) {
          set.delete(f.id);
          if (set.size === 0) {
            this.state.orderIndex.delete(orderId);
          }
        }
      }
    }
  }

  private markDirty(): void {
    this.dirty = true;
  }

  /** 初始化地点配置（每地点仅允许一次，运行期间不修改）。 */
  async configureLocation(locationId: LocationId, config: LocationConfig): Promise<void> {
    return this.enqueue(() => {
      if (this.state.locations.has(locationId)) {
        throw new StoreError('INVALID_ARGUMENT', `location already configured: ${locationId}`);
      }
      assertNonNegativeInteger(config.capacity, 'capacity');
      for (const [sku, skuConfig] of Object.entries(config.skus)) {
        assertNonNegativeInteger(skuConfig.total, `sku ${sku} total`);
        assertNonNegativeInteger(skuConfig.safetyStock, `sku ${sku} safetyStock`);
      }
      this.state.locations.set(locationId, {
        capacity: config.capacity,
        skus: { ...config.skus },
      });
      this.usageOf(locationId);
      this.markDirty();
    });
  }

  /** 提交原始订单：生成一张生效履约单并预留全部数量，返回履约单 ID。 */
  async submitOrder(orderId: OriginalOrderId, locationId: LocationId, lines: OrderLine[]): Promise<FulfillmentOrderId> {
    return this.enqueue(() => {
      this.requireLocation(locationId);
      if (this.state.orders.has(orderId)) {
        throw new StoreError('ORDER_ALREADY_EXISTS', `duplicate order id: ${orderId}`);
      }
      if (lines.length === 0) {
        throw new StoreError('INVALID_ARGUMENT', 'order must contain at least one line');
      }
      const submitted = new Map<SkuId, number>();
      for (const line of lines) {
        assertPositiveInteger(line.quantity, `quantity of sku ${line.sku}`);
        submitted.set(line.sku, (submitted.get(line.sku) ?? 0) + line.quantity);
      }
      const fulfillmentLines = new Map<SkuId, Map<OriginalOrderId, number>>();
      for (const [sku, qty] of submitted) {
        fulfillmentLines.set(sku, new Map([[orderId, qty]]));
      }
      const candidate: FulfillmentOrder = { id: '', locationId, status: 'active', lines: fulfillmentLines };
      this.checkResourcesAfter([], [candidate]);
      const created = this.newFulfillment(locationId, fulfillmentLines);
      this.state.orders.set(orderId, { id: orderId, status: 'active', submitted });
      this.markDirty();
      return created.id;
    });
  }

  /** 拆分一张生效履约单为至少两张新单。 */
  async split(fulfillmentId: FulfillmentOrderId, targets: SplitTargetSpec[]): Promise<FulfillmentOrderId[]> {
    return this.enqueue(() => {
      const source = this.requireActiveFulfillment(fulfillmentId);
      if (targets.length < 2) {
        throw new StoreError('INVALID_ARGUMENT', 'split requires at least two targets');
      }
      const newLinesList: Map<SkuId, Map<OriginalOrderId, number>>[] = [];
      const totals = new Map<SkuId, Map<OriginalOrderId, number>>();
      for (const target of targets) {
        this.requireLocation(target.locationId);
        if (target.lines.length === 0) {
          throw new StoreError('INVALID_ARGUMENT', 'split target must contain at least one line');
        }
        const lines = new Map<SkuId, Map<OriginalOrderId, number>>();
        for (const line of target.lines) {
          assertPositiveInteger(line.quantity, `quantity of sku ${line.sku} for order ${line.orderId}`);
          addQuantity(lines, line.sku, line.orderId, line.quantity);
          addQuantity(totals, line.sku, line.orderId, line.quantity);
        }
        newLinesList.push(lines);
      }
      if (!linesEqual(totals, source.lines)) {
        throw new StoreError(
          'QUANTITY_MISMATCH',
          `split quantities do not match source fulfillment ${fulfillmentId}`,
        );
      }
      const candidates: FulfillmentOrder[] = targets.map((target, i) => ({
        id: '',
        locationId: target.locationId,
        status: 'active',
        lines: newLinesList[i] as Map<SkuId, Map<OriginalOrderId, number>>,
      }));
      this.checkResourcesAfter([source], candidates);
      this.deactivate(source);
      const ids = candidates.map((c) => this.newFulfillment(c.locationId, c.lines).id);
      this.markDirty();
      return ids;
    });
  }

  /** 合并至少两张生效履约单为一张新单。 */
  async merge(fulfillmentIds: FulfillmentOrderId[], targetLocationId: LocationId): Promise<FulfillmentOrderId> {
    return this.enqueue(() => {
      this.requireLocation(targetLocationId);
      if (fulfillmentIds.length < 2) {
        throw new StoreError('INVALID_ARGUMENT', 'merge requires at least two fulfillment orders');
      }
      if (new Set(fulfillmentIds).size !== fulfillmentIds.length) {
        throw new StoreError('INVALID_ARGUMENT', 'duplicate fulfillment id in merge input');
      }
      const sources = fulfillmentIds.map((id) => this.requireActiveFulfillment(id));
      const mergedLines = new Map<SkuId, Map<OriginalOrderId, number>>();
      for (const source of sources) {
        for (const [sku, perOrder] of source.lines) {
          for (const [orderId, qty] of perOrder) {
            addQuantity(mergedLines, sku, orderId, qty);
          }
        }
      }
      const candidate: FulfillmentOrder = {
        id: '',
        locationId: targetLocationId,
        status: 'active',
        lines: mergedLines,
      };
      this.checkResourcesAfter(sources, [candidate]);
      for (const source of sources) {
        this.deactivate(source);
      }
      const created = this.newFulfillment(targetLocationId, mergedLines);
      this.markDirty();
      return created.id;
    });
  }

  /** 按原始订单取消：从所有生效履约单移除其数量并释放库存。 */
  async cancelOrder(orderId: OriginalOrderId): Promise<void> {
    return this.enqueue(() => {
      const order = this.state.orders.get(orderId);
      if (!order) {
        throw new StoreError('ORDER_NOT_FOUND', `unknown order: ${orderId}`);
      }
      if (order.status === 'cancelled') {
        return; // 重复取消：不再次释放
      }
      const containing = [...(this.state.orderIndex.get(orderId) ?? [])];
      for (const fulfillmentId of containing) {
        const f = this.state.fulfillments.get(fulfillmentId);
        if (!f || f.status !== 'active') continue;
        const u = this.usageOf(f.locationId);
        for (const [sku, perOrder] of f.lines) {
          const qty = perOrder.get(orderId);
          if (qty === undefined) continue;
          perOrder.delete(orderId);
          this.addSkuUsage(u, sku, -qty);
          if (perOrder.size === 0) {
            f.lines.delete(sku);
          }
        }
        if (f.lines.size === 0) {
          this.deactivate(f); // 变空才释放名额
        }
      }
      this.state.orderIndex.delete(orderId);
      order.status = 'cancelled';
      this.markDirty();
    });
  }

  getFulfillment(id: FulfillmentOrderId): FulfillmentOrderView | undefined {
    const f = this.state.fulfillments.get(id);
    if (!f) return undefined;
    return this.toFulfillmentView(f);
  }

  listActiveFulfillments(): FulfillmentOrderView[] {
    const views: FulfillmentOrderView[] = [];
    for (const f of this.state.fulfillments.values()) {
      if (f.status === 'active') views.push(this.toFulfillmentView(f));
    }
    return views;
  }

  private toFulfillmentView(f: FulfillmentOrder): FulfillmentOrderView {
    const lines = new Map<SkuId, ReadonlyMap<OriginalOrderId, number>>();
    for (const [sku, perOrder] of f.lines) {
      lines.set(sku, new Map(perOrder));
    }
    return { id: f.id, locationId: f.locationId, status: f.status, lines };
  }

  getOrder(id: OriginalOrderId): OriginalOrderView | undefined {
    const order = this.state.orders.get(id);
    if (!order) return undefined;
    return { id: order.id, status: order.status, submitted: new Map(order.submitted) };
  }

  getLocationSku(locationId: LocationId, sku: SkuId): LocationSkuView {
    const config = this.requireLocation(locationId);
    const reserved = this.state.usage.get(locationId)?.reserved.get(sku) ?? 0;
    const skuConfig = config.skus[sku];
    const total = skuConfig?.total ?? 0;
    const safetyStock = skuConfig?.safetyStock ?? 0;
    return { total, safetyStock, reserved, available: total - safetyStock - reserved };
  }

  getLocationCapacity(locationId: LocationId): LocationCapacityView {
    const config = this.requireLocation(locationId);
    const used = this.state.usage.get(locationId)?.usedSlots ?? 0;
    return { capacity: config.capacity, used, available: config.capacity - used };
  }

  /** 立即把当前状态落盘（正常关闭时会自动调用）。 */
  async flush(): Promise<void> {
    return this.enqueue(() => {
      if (this.dirty) {
        this.persistence.save(this.state);
        this.dirty = false;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const pending = this.queue;
    this.closed = true;
    await pending;
    if (this.dirty) {
      this.persistence.save(this.state);
      this.dirty = false;
    }
  }
}
