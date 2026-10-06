import { DatabaseSync } from 'node:sqlite';
import { FulfillmentOrder, LocationConfig } from './types';

/**
 * 持久化层：内存状态的每一次变更都通过本层在一个 SQLite 事务内落盘。
 * 正常关闭后重开，调用方按 load* 读回的状态与关闭前一致。
 */
export class Store {
  private db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        location_id TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS location_inventory (
        location_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        total INTEGER NOT NULL,
        safety_stock INTEGER NOT NULL,
        PRIMARY KEY (location_id, sku)
      );
      CREATE TABLE IF NOT EXISTS fulfillments (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        location_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fulfillment_lines (
        fulfillment_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        qty INTEGER NOT NULL,
        PRIMARY KEY (fulfillment_id, order_id, sku)
      );
      CREATE TABLE IF NOT EXISTS submitted_orders (
        order_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS canceled_orders (
        order_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** 在一个事务里执行一批写入，任一失败整体回滚 */
  transact(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  saveLocation(config: LocationConfig): void {
    this.db
      .prepare('INSERT INTO locations (location_id, capacity) VALUES (?, ?)')
      .run(config.locationId, config.capacity);
    const stmt = this.db.prepare(
      'INSERT INTO location_inventory (location_id, sku, total, safety_stock) VALUES (?, ?, ?, ?)',
    );
    for (const sku of Object.keys(config.inventory)) {
      const stock = config.inventory[sku];
      stmt.run(config.locationId, sku, stock.total, stock.safetyStock);
    }
  }

  /** 全量重写一张履约单（行项目先删后插，状态随之更新） */
  saveFulfillment(fo: FulfillmentOrder, seq: number): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO fulfillments (id, seq, location_id, status) VALUES (?, ?, ?, ?)',
      )
      .run(fo.id, seq, fo.locationId, fo.status);
    this.db
      .prepare('DELETE FROM fulfillment_lines WHERE fulfillment_id = ?')
      .run(fo.id);
    const stmt = this.db.prepare(
      'INSERT INTO fulfillment_lines (fulfillment_id, order_id, sku, qty) VALUES (?, ?, ?, ?)',
    );
    for (const orderId of Object.keys(fo.lines)) {
      const quantities = fo.lines[orderId];
      for (const sku of Object.keys(quantities)) {
        stmt.run(fo.id, orderId, sku, quantities[sku]);
      }
    }
  }

  saveSubmittedOrder(orderId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO submitted_orders (order_id) VALUES (?)').run(orderId);
  }

  saveCanceledOrder(orderId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO canceled_orders (order_id) VALUES (?)').run(orderId);
  }

  saveMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  loadLocations(): LocationConfig[] {
    const locations: LocationConfig[] = [];
    const rows = this.db
      .prepare('SELECT location_id, capacity FROM locations')
      .all() as Array<{ location_id: string; capacity: number }>;
    const invStmt = this.db.prepare(
      'SELECT sku, total, safety_stock FROM location_inventory WHERE location_id = ?',
    );
    for (const row of rows) {
      const inventory: LocationConfig['inventory'] = {};
      const invRows = invStmt.all(row.location_id) as Array<{
        sku: string;
        total: number;
        safety_stock: number;
      }>;
      for (const inv of invRows) {
        inventory[inv.sku] = { total: inv.total, safetyStock: inv.safety_stock };
      }
      locations.push({ locationId: row.location_id, capacity: row.capacity, inventory });
    }
    return locations;
  }

  /** 返回履约单及其创建序号（按序号升序） */
  loadFulfillments(): Array<{ fo: FulfillmentOrder; seq: number }> {
    const rows = this.db
      .prepare('SELECT id, seq, location_id, status FROM fulfillments ORDER BY seq ASC')
      .all() as Array<{ id: string; seq: number; location_id: string; status: string }>;
    const lineStmt = this.db.prepare(
      'SELECT order_id, sku, qty FROM fulfillment_lines WHERE fulfillment_id = ?',
    );
    return rows.map((row) => {
      const lines: FulfillmentOrder['lines'] = {};
      const lineRows = lineStmt.all(row.id) as Array<{
        order_id: string;
        sku: string;
        qty: number;
      }>;
      for (const line of lineRows) {
        if (!lines[line.order_id]) lines[line.order_id] = {};
        lines[line.order_id][line.sku] = line.qty;
      }
      return {
        fo: {
          id: row.id,
          locationId: row.location_id,
          status: row.status === 'active' ? 'active' : 'inactive',
          lines,
        },
        seq: row.seq,
      };
    });
  }

  loadSubmittedOrders(): string[] {
    const rows = this.db.prepare('SELECT order_id FROM submitted_orders').all() as Array<{
      order_id: string;
    }>;
    return rows.map((r) => r.order_id);
  }

  loadCanceledOrders(): string[] {
    const rows = this.db.prepare('SELECT order_id FROM canceled_orders').all() as Array<{
      order_id: string;
    }>;
    return rows.map((r) => r.order_id);
  }

  loadMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  close(): void {
    this.db.close();
  }
}
