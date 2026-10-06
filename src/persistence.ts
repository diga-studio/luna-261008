import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FulfillmentOrder, OriginalOrder, State } from './state.js';
import { createEmptyState, rebuildDerived } from './state.js';
import type {
  FulfillmentOrderId,
  FulfillmentStatus,
  LocationConfig,
  LocationId,
  OriginalOrderId,
  OriginalOrderStatus,
  SkuId,
} from './types.js';

const FORMAT_VERSION = 1;

interface SerializedState {
  version: number;
  nextFulfillmentSeq: number;
  locations: [LocationId, LocationConfig][];
  orders: [OriginalOrderId, SerializedOrder][];
  fulfillments: [FulfillmentOrderId, SerializedFulfillment][];
}

interface SerializedOrder {
  status: OriginalOrderStatus;
  submitted: [SkuId, number][];
}

interface SerializedFulfillment {
  locationId: LocationId;
  status: FulfillmentStatus;
  lines: [SkuId, [OriginalOrderId, number][]][];
}

function serialize(state: State): SerializedState {
  const orders: [OriginalOrderId, SerializedOrder][] = [];
  for (const [id, order] of state.orders) {
    orders.push([id, { status: order.status, submitted: [...order.submitted] }]);
  }
  const fulfillments: [FulfillmentOrderId, SerializedFulfillment][] = [];
  for (const [id, f] of state.fulfillments) {
    const lines: [SkuId, [OriginalOrderId, number][]][] = [];
    for (const [sku, perOrder] of f.lines) {
      lines.push([sku, [...perOrder]]);
    }
    fulfillments.push([id, { locationId: f.locationId, status: f.status, lines }]);
  }
  return {
    version: FORMAT_VERSION,
    nextFulfillmentSeq: state.nextFulfillmentSeq,
    locations: [...state.locations],
    orders,
    fulfillments,
  };
}

function deserialize(data: SerializedState): State {
  if (data.version !== FORMAT_VERSION) {
    throw new Error(`unsupported state format version: ${data.version}`);
  }
  const state = createEmptyState();
  state.nextFulfillmentSeq = data.nextFulfillmentSeq;
  for (const [id, config] of data.locations) {
    state.locations.set(id, config);
  }
  for (const [id, o] of data.orders) {
    const order: OriginalOrder = { id, status: o.status, submitted: new Map(o.submitted) };
    state.orders.set(id, order);
  }
  for (const [id, f] of data.fulfillments) {
    const fulfillment: FulfillmentOrder = {
      id,
      locationId: f.locationId,
      status: f.status,
      lines: new Map(f.lines.map(([sku, perOrder]) => [sku, new Map(perOrder)])),
    };
    state.fulfillments.set(id, fulfillment);
  }
  return state;
}

/** 基于本地 JSON 文件的持久化（原子写：临时文件 + rename）。 */
export class FilePersistence {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): State {
    if (!existsSync(this.filePath)) {
      return createEmptyState();
    }
    const raw = readFileSync(this.filePath, 'utf8');
    const state = deserialize(JSON.parse(raw) as SerializedState);
    rebuildDerived(state);
    return state;
  }

  save(state: State): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(serialize(state)), 'utf8');
    renameSync(tmpPath, this.filePath);
  }
}
