import { Store } from './store';
import {
  FulfillmentOrder,
  LocationConfig,
  LocationUsage,
  Result,
  SkuQuantities,
  SkuStockConfig,
  SplitSpec,
} from './types';

const META_NEXT_SEQ = 'nextFulfillmentSeq';

function cloneQuantities(q: SkuQuantities): SkuQuantities {
  return { ...q };
}

function deepCopyFulfillment(fo: FulfillmentOrder): FulfillmentOrder {
  const lines: FulfillmentOrder['lines'] = {};
  for (const orderId of Object.keys(fo.lines)) {
    lines[orderId] = { ...fo.lines[orderId] };
  }
  return { id: fo.id, locationId: fo.locationId, status: fo.status, lines };
}

/** 校验一组 SKU 数量：非空、每个数量为正整数 */
function validateQuantities(q: SkuQuantities): string | null {
  const skus = Object.keys(q);
  if (skus.length === 0) return 'quantities must not be empty';
  for (const sku of skus) {
    const n = q[sku];
    if (!Number.isInteger(n) || n <= 0) return `invalid quantity for sku ${sku}: ${n}`;
  }
  return null;
}

/**
 * 订单拆并与库存预留服务，由上层 OMS 直接调用。
 * 所有公开方法均为同步：一次调用要么完整生效并落盘，要么整体不变，
 * 同进程并发调用只会看到某次操作之前或之后的完整状态。
 */
export class OrderInventoryService {
  private store: Store;
  private locations: Map<string, LocationConfig> = new Map();
  private fulfillments: Map<string, FulfillmentOrder> = new Map();
  private canceledOrders: Set<string> = new Set();
  private submittedOrders: Set<string> = new Set();
  private seqs: Map<string, number> = new Map();
  private nextSeq: number;

  constructor(filePath: string) {
    this.store = new Store(filePath);
    for (const loc of this.store.loadLocations()) {
      this.locations.set(loc.locationId, loc);
    }
    let maxSeq = 0;
    for (const { fo, seq } of this.store.loadFulfillments()) {
      this.fulfillments.set(fo.id, fo);
      this.seqs.set(fo.id, seq);
      if (seq > maxSeq) maxSeq = seq;
    }
    for (const id of this.store.loadSubmittedOrders()) this.submittedOrders.add(id);
    for (const id of this.store.loadCanceledOrders()) this.canceledOrders.add(id);
    const metaSeq = this.store.loadMeta(META_NEXT_SEQ);
    this.nextSeq = metaSeq !== null ? parseInt(metaSeq, 10) : maxSeq + 1;
  }

  /** 初始化地点库存与容量；运行期间不允许修改 */
  configureLocation(
    locationId: string,
    capacity: number,
    inventory: Record<string, SkuStockConfig>,
  ): Result<null> {
    if (this.locations.has(locationId)) {
      return { ok: false, error: `location ${locationId} already configured` };
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      return { ok: false, error: 'capacity must be a positive integer' };
    }
    for (const sku of Object.keys(inventory)) {
      const s = inventory[sku];
      if (!Number.isInteger(s.total) || s.total < 0) {
        return { ok: false, error: `invalid total for sku ${sku}` };
      }
      if (!Number.isInteger(s.safetyStock) || s.safetyStock < 0 || s.safetyStock > s.total) {
        return { ok: false, error: `invalid safetyStock for sku ${sku}` };
      }
    }
    const config: LocationConfig = {
      locationId,
      capacity,
      inventory: JSON.parse(JSON.stringify(inventory)) as Record<string, SkuStockConfig>,
    };
    this.store.transact(() => this.store.saveLocation(config));
    this.locations.set(locationId, config);
    return { ok: true, value: null };
  }

  /** 提交原始订单：生成一张生效履约单并预留其全部 SKU 数量 */
  submitOrder(orderId: string, locationId: string, quantities: SkuQuantities): Result<string> {
    const location = this.locations.get(locationId);
    if (!location) return { ok: false, error: `unknown location ${locationId}` };
    if (this.submittedOrders.has(orderId)) {
      return { ok: false, error: `order ${orderId} already submitted` };
    }
    const qErr = validateQuantities(quantities);
    if (qErr) return { ok: false, error: qErr };

    const fo: FulfillmentOrder = {
      id: this.allocFulfillmentId(),
      locationId,
      status: 'active',
      lines: { [orderId]: cloneQuantities(quantities) },
    };
    const resErr = this.checkLocation(locationId, new Set(), [fo]);
    if (resErr) return { ok: false, error: resErr };

    const seq = this.nextSeq;
    this.store.transact(() => {
      this.store.saveFulfillment(fo, seq);
      this.store.saveSubmittedOrder(orderId);
      this.store.saveMeta(META_NEXT_SEQ, String(seq + 1));
    });
    this.nextSeq = seq + 1;
    this.fulfillments.set(fo.id, fo);
    this.seqs.set(fo.id, seq);
    this.submittedOrders.add(orderId);
    return { ok: true, value: fo.id };
  }

  /** 拆分一张生效履约单为至少两张新单 */
  split(fulfillmentId: string, specs: SplitSpec[]): Result<string[]> {
    const source = this.fulfillments.get(fulfillmentId);
    if (!source) return { ok: false, error: `unknown fulfillment ${fulfillmentId}` };
    if (source.status !== 'active') {
      return { ok: false, error: `fulfillment ${fulfillmentId} is not active` };
    }
    if (!Array.isArray(specs) || specs.length < 2) {
      return { ok: false, error: 'split requires at least 2 target specs' };
    }
    for (const spec of specs) {
      if (!this.locations.has(spec.locationId)) {
        return { ok: false, error: `unknown location ${spec.locationId}` };
      }
      if (!Array.isArray(spec.lines) || spec.lines.length === 0) {
        return { ok: false, error: 'each split spec must have lines' };
      }
      for (const line of spec.lines) {
        const qErr = validateQuantities(line.quantities);
        if (qErr) return { ok: false, error: qErr };
      }
    }

    // 按原始订单及 SKU 分别汇总，必须与被拆单完全相等
    const sums = new Map<string, SkuQuantities>();
    for (const spec of specs) {
      for (const line of spec.lines) {
        let entry = sums.get(line.orderId);
        if (!entry) {
          entry = {};
          sums.set(line.orderId, entry);
        }
        for (const sku of Object.keys(line.quantities)) {
          entry[sku] = (entry[sku] ?? 0) + line.quantities[sku];
        }
      }
    }
    const eqErr = this.compareLines(source.lines, sums);
    if (eqErr) return { ok: false, error: eqErr };

    const removals = new Set([source.id]);
    const newFos: FulfillmentOrder[] = [];
    for (let i = 0; i < specs.length; i++) {
      const lines: FulfillmentOrder['lines'] = {};
      for (const line of specs[i].lines) {
        if (!lines[line.orderId]) lines[line.orderId] = {};
        for (const sku of Object.keys(line.quantities)) {
          lines[line.orderId][sku] = (lines[line.orderId][sku] ?? 0) + line.quantities[sku];
        }
      }
      newFos.push({
        id: this.allocFulfillmentId(i),
        locationId: specs[i].locationId,
        status: 'active',
        lines,
      });
    }
    const affected = new Set<string>([source.locationId]);
    for (const fo of newFos) affected.add(fo.locationId);
    for (const locId of affected) {
      const resErr = this.checkLocation(locId, removals, newFos);
      if (resErr) return { ok: false, error: resErr };
    }

    const firstSeq = this.nextSeq;
    this.store.transact(() => {
      const inactiveSource: FulfillmentOrder = { ...source, status: 'inactive' };
      this.store.saveFulfillment(inactiveSource, this.seqs.get(source.id)!);
      newFos.forEach((fo, i) => this.store.saveFulfillment(fo, firstSeq + i));
      this.store.saveMeta(META_NEXT_SEQ, String(firstSeq + newFos.length));
    });
    this.nextSeq = firstSeq + newFos.length;
    source.status = 'inactive';
    newFos.forEach((fo, i) => {
      this.fulfillments.set(fo.id, fo);
      this.seqs.set(fo.id, firstSeq + i);
    });
    return { ok: true, value: newFos.map((fo) => fo.id) };
  }

  /** 合并至少两张生效履约单为一张新单 */
  merge(fulfillmentIds: string[], targetLocationId: string): Result<string> {
    if (!this.locations.has(targetLocationId)) {
      return { ok: false, error: `unknown location ${targetLocationId}` };
    }
    if (!Array.isArray(fulfillmentIds) || fulfillmentIds.length < 2) {
      return { ok: false, error: 'merge requires at least 2 fulfillments' };
    }
    const uniqueIds = new Set(fulfillmentIds);
    if (uniqueIds.size !== fulfillmentIds.length) {
      return { ok: false, error: 'duplicate fulfillment ids' };
    }
    const inputs: FulfillmentOrder[] = [];
    for (const id of fulfillmentIds) {
      const fo = this.fulfillments.get(id);
      if (!fo) return { ok: false, error: `unknown fulfillment ${id}` };
      if (fo.status !== 'active') {
        return { ok: false, error: `fulfillment ${id} is not active` };
      }
      inputs.push(fo);
    }

    // 相同 SKU 累加，保留每份数量的原始订单归属
    const lines: FulfillmentOrder['lines'] = {};
    for (const fo of inputs) {
      for (const orderId of Object.keys(fo.lines)) {
        if (!lines[orderId]) lines[orderId] = {};
        for (const sku of Object.keys(fo.lines[orderId])) {
          lines[orderId][sku] = (lines[orderId][sku] ?? 0) + fo.lines[orderId][sku];
        }
      }
    }
    const merged: FulfillmentOrder = {
      id: this.allocFulfillmentId(),
      locationId: targetLocationId,
      status: 'active',
      lines,
    };
    const removals = new Set(inputs.map((fo) => fo.id));
    const affected = new Set<string>(inputs.map((fo) => fo.locationId));
    affected.add(targetLocationId);
    for (const locId of affected) {
      const resErr = this.checkLocation(locId, removals, [merged]);
      if (resErr) return { ok: false, error: resErr };
    }

    const seq = this.nextSeq;
    this.store.transact(() => {
      for (const fo of inputs) {
        this.store.saveFulfillment({ ...fo, status: 'inactive' }, this.seqs.get(fo.id)!);
      }
      this.store.saveFulfillment(merged, seq);
      this.store.saveMeta(META_NEXT_SEQ, String(seq + 1));
    });
    this.nextSeq = seq + 1;
    for (const fo of inputs) fo.status = 'inactive';
    this.fulfillments.set(merged.id, merged);
    this.seqs.set(merged.id, seq);
    return { ok: true, value: merged.id };
  }

  /** 按原始订单取消：从所有生效履约单移除其全部数量并释放库存；重复取消为无操作 */
  cancelOrder(orderId: string): Result<null> {
    if (!this.submittedOrders.has(orderId) || this.canceledOrders.has(orderId)) {
      return { ok: true, value: null };
    }
    const touched: FulfillmentOrder[] = [];
    for (const fo of this.fulfillments.values()) {
      if (fo.status === 'active' && fo.lines[orderId]) touched.push(fo);
    }
    this.store.transact(() => {
      for (const fo of touched) {
        const updated = deepCopyFulfillment(fo);
        delete updated.lines[orderId];
        if (Object.keys(updated.lines).length === 0) updated.status = 'inactive';
        this.store.saveFulfillment(updated, this.seqs.get(fo.id)!);
      }
      this.store.saveCanceledOrder(orderId);
    });
    for (const fo of touched) {
      delete fo.lines[orderId];
      if (Object.keys(fo.lines).length === 0) fo.status = 'inactive';
    }
    this.canceledOrders.add(orderId);
    return { ok: true, value: null };
  }

  /** 查询某地点的资源占用快照（仅统计生效履约单） */
  getLocationUsage(locationId: string): LocationUsage | null {
    const location = this.locations.get(locationId);
    if (!location) return null;
    const usage = this.simulateUsage(locationId, new Set(), []);
    return {
      locationId,
      activeFulfillments: usage.activeCount,
      capacity: location.capacity,
      reserved: usage.reserved,
    };
  }

  /** 查询某原始订单在所有生效履约单中的各 SKU 数量之和 */
  getOrderQuantities(orderId: string): SkuQuantities {
    const result: SkuQuantities = {};
    for (const fo of this.fulfillments.values()) {
      if (fo.status !== 'active') continue;
      const line = fo.lines[orderId];
      if (!line) continue;
      for (const sku of Object.keys(line)) {
        result[sku] = (result[sku] ?? 0) + line[sku];
      }
    }
    return result;
  }

  /** 查询履约单（返回副本） */
  getFulfillment(fulfillmentId: string): FulfillmentOrder | null {
    const fo = this.fulfillments.get(fulfillmentId);
    return fo ? deepCopyFulfillment(fo) : null;
  }

  /** 列出全部生效履约单（返回副本），供上层独立汇总核对 */
  listActiveFulfillments(): FulfillmentOrder[] {
    const result: FulfillmentOrder[] = [];
    for (const fo of this.fulfillments.values()) {
      if (fo.status === 'active') result.push(deepCopyFulfillment(fo));
    }
    return result;
  }

  close(): void {
    this.store.close();
  }

  private allocFulfillmentId(offset = 0): string {
    return `FO-${this.nextSeq + offset}`;
  }

  /** 比较被拆单的订单数量与拆分汇总是否完全相等 */
  private compareLines(
    expected: FulfillmentOrder['lines'],
    actualSums: Map<string, SkuQuantities>,
  ): string | null {
    const expectedOrders = Object.keys(expected).sort();
    const actualOrders = [...actualSums.keys()].sort();
    if (expectedOrders.join('') !== actualOrders.join('')) {
      return 'split lines do not match source orders';
    }
    for (const orderId of expectedOrders) {
      const exp = expected[orderId];
      const act = actualSums.get(orderId)!;
      const expSkus = Object.keys(exp).sort();
      const actSkus = Object.keys(act).sort();
      if (expSkus.join('') !== actSkus.join('')) {
        return `split lines do not match source skus for order ${orderId}`;
      }
      for (const sku of expSkus) {
        if (exp[sku] !== act[sku]) {
          return `split quantity mismatch for order ${orderId} sku ${sku}`;
        }
      }
    }
    return null;
  }

  /**
   * 模拟某地点在一次操作后的占用：先移除 removals 中的履约单，再加入 additions。
   * 原预留因此可以参与本次重新核算（原地拆并不会因自己占满库存而失败）。
   */
  private simulateUsage(
    locationId: string,
    removals: Set<string>,
    additions: FulfillmentOrder[],
  ): { reserved: SkuQuantities; activeCount: number } {
    const reserved: SkuQuantities = {};
    let activeCount = 0;
    const accumulate = (fo: FulfillmentOrder) => {
      activeCount += 1;
      for (const orderId of Object.keys(fo.lines)) {
        const line = fo.lines[orderId];
        for (const sku of Object.keys(line)) {
          reserved[sku] = (reserved[sku] ?? 0) + line[sku];
        }
      }
    };
    for (const fo of this.fulfillments.values()) {
      if (fo.locationId !== locationId || fo.status !== 'active') continue;
      if (removals.has(fo.id)) continue;
      accumulate(fo);
    }
    for (const fo of additions) {
      if (fo.locationId !== locationId) continue;
      accumulate(fo);
    }
    return { reserved, activeCount };
  }

  /** 校验某地点操作后的库存与容量约束，返回错误信息或 null */
  private checkLocation(
    locationId: string,
    removals: Set<string>,
    additions: FulfillmentOrder[],
  ): string | null {
    const location = this.locations.get(locationId)!;
    const { reserved, activeCount } = this.simulateUsage(locationId, removals, additions);
    if (activeCount > location.capacity) {
      return `location ${locationId} capacity exceeded: ${activeCount} > ${location.capacity}`;
    }
    for (const sku of Object.keys(reserved)) {
      const stock = location.inventory[sku];
      const available = stock ? stock.total - stock.safetyStock : 0;
      if (reserved[sku] > available) {
        return `location ${locationId} sku ${sku} stock exceeded: ${reserved[sku]} > ${available}`;
      }
    }
    return null;
  }
}
