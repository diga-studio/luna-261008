import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { allocate, lineKey } from './matching.js';
import type { InvoiceState, OrderLineState } from './matching.js';
import { roundHalfUpToCents, toInt } from './num.js';
import type {
  InvoiceInput,
  OrderInput,
  ReceiptInput,
  Snapshot,
} from './types.js';

interface NormalizedReceiptLine {
  orderId: string;
  lineId: string;
  qualified: string;
  pending: string;
  unqualified: string;
}

interface NormalizedInvoiceLine {
  orderId: string;
  lineId: string;
  qty: string;
  amountCents: string;
}

interface CachedInvoice {
  invoiceId: string;
  seq: number;
  voided: boolean;
  settled: boolean;
  lines: NormalizedInvoiceLine[];
}

/** 同号不同内容：数据保持不变并抛出。 */
export class OpConflictError extends Error {
  constructor(opId: string) {
    super(`操作号 ${opId} 已以不同内容登记过`);
    this.name = 'OpConflictError';
  }
}

export class ReconciliationStore {
  private readonly db: DatabaseSync;
  /** 内存缓存：与库内已提交数据一致，避免每次重分配都解析全量 JSON。 */
  private orderLines = new Map<string, OrderLineState & { currency: string }>();
  private receipts = new Map<string, NormalizedReceiptLine[]>();
  private invoices: CachedInvoice[] = [];

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.loadCache();
  }

  /** 打开（或创建）位于 path 的 SQLite 库。 */
  static open(path: string): ReconciliationStore {
    return new ReconciliationStore(openDatabase(path));
  }

  close(): void {
    this.db.close();
  }

  /** 初始化登记固定采购订单及其行。 */
  registerOrder(opId: string, order: OrderInput): void {
    const lines = order.lines.map((line) => ({
      lineId: line.lineId,
      qty: toInt(line.qty, 'order.qty').toString(),
      priceCents: toInt(line.priceCents, 'order.priceCents').toString(),
    }));
    const payload = { orderId: order.orderId, currency: order.currency, lines };
    this.runOp(opId, 'order', payload, () => {
      for (const c of new Set([...this.orderLines.values()].map((l) => l.currency))) {
        if (c !== order.currency) {
          throw new Error(`本期只处理同币种，已有 ${c}，收到 ${order.currency}`);
        }
      }
      const insert = this.db.prepare(
        'INSERT INTO order_lines (order_id, line_id, currency, qty, price_cents) VALUES (?, ?, ?, ?, ?)',
      );
      for (const line of lines) {
        insert.run(order.orderId, line.lineId, order.currency, line.qty, line.priceCents);
        this.orderLines.set(lineKey(order.orderId, line.lineId), {
          orderId: order.orderId,
          lineId: line.lineId,
          currency: order.currency,
          qty: BigInt(line.qty),
          priceCents: BigInt(line.priceCents),
        });
      }
    });
  }

  /** 登记或更正收货；同一 receiptId 整体替换原内容。 */
  registerReceipt(opId: string, receipt: ReceiptInput): void {
    const lines: NormalizedReceiptLine[] = receipt.lines.map((line) => ({
      orderId: line.orderId,
      lineId: line.lineId,
      qualified: toInt(line.qualified, 'receipt.qualified').toString(),
      pending: toInt(line.pending, 'receipt.pending').toString(),
      unqualified: toInt(line.unqualified, 'receipt.unqualified').toString(),
    }));
    const payload = { receiptId: receipt.receiptId, lines };
    this.runOp(opId, 'receipt', payload, () => {
      for (const line of lines) {
        this.requireOrderLine(line.orderId, line.lineId);
      }
      this.db
        .prepare(
          'INSERT INTO receipts (receipt_id, lines) VALUES (?, ?) ' +
            'ON CONFLICT (receipt_id) DO UPDATE SET lines = excluded.lines',
        )
        .run(receipt.receiptId, JSON.stringify(lines));
      this.receipts.set(receipt.receiptId, lines);
    });
  }

  /** 登记发票。 */
  registerInvoice(opId: string, invoice: InvoiceInput): void {
    const lines: NormalizedInvoiceLine[] = invoice.lines.map((line) => ({
      orderId: line.orderId,
      lineId: line.lineId,
      qty: toInt(line.qty, 'invoice.qty').toString(),
      amountCents: toInt(line.amountCents, 'invoice.amountCents').toString(),
    }));
    const payload = { invoiceId: invoice.invoiceId, lines };
    this.runOp(opId, 'invoice', payload, () => {
      for (const line of lines) {
        this.requireOrderLine(line.orderId, line.lineId);
      }
      if (this.invoices.some((inv) => inv.invoiceId === invoice.invoiceId)) {
        throw new Error(`发票 ${invoice.invoiceId} 已登记`);
      }
      const seq = this.invoices.reduce((max, inv) => Math.max(max, inv.seq), 0) + 1;
      this.db
        .prepare('INSERT INTO invoices (invoice_id, seq, voided, settled, lines) VALUES (?, ?, 0, 0, ?)')
        .run(invoice.invoiceId, seq, JSON.stringify(lines));
      this.invoices.push({ invoiceId: invoice.invoiceId, seq, voided: false, settled: false, lines });
    });
  }

  /** 撤销发票；撤销票不参与分配。 */
  voidInvoice(opId: string, invoiceId: string): void {
    const payload = { invoiceId };
    this.runOp(opId, 'void', payload, () => {
      const cur = this.db
        .prepare('UPDATE invoices SET voided = 1 WHERE invoice_id = ?')
        .run(invoiceId);
      if (cur.changes === 0) {
        throw new Error(`发票 ${invoiceId} 不存在`);
      }
      const cached = this.invoices.find((inv) => inv.invoiceId === invoiceId);
      if (cached !== undefined) {
        cached.voided = true;
      }
    });
  }

  /** 读取核销快照（只含完整版本；写入返回即对这里可见）。 */
  getSnapshot(): Snapshot {
    const invoices = this.invoices.map((inv) => ({
      invoiceId: inv.invoiceId,
      seq: inv.seq,
      status: (inv.voided ? 'VOIDED' : inv.settled ? 'SETTLED' : 'PENDING') as
        | 'VOIDED'
        | 'SETTLED'
        | 'PENDING',
    }));

    const qualified = this.qualifiedQtyByLine();
    const matchedQty = new Map<string, bigint>();
    const matchedAmount = new Map<string, bigint>();
    for (const inv of this.invoices) {
      if (inv.voided || !inv.settled) {
        continue;
      }
      for (const line of inv.lines) {
        const key = lineKey(line.orderId, line.lineId);
        matchedQty.set(key, (matchedQty.get(key) ?? 0n) + BigInt(line.qty));
        matchedAmount.set(key, (matchedAmount.get(key) ?? 0n) + BigInt(line.amountCents));
      }
    }

    const lines = [...this.orderLines.values()]
      .sort((a, b) =>
        a.orderId === b.orderId
          ? a.lineId.localeCompare(b.lineId)
          : a.orderId.localeCompare(b.orderId),
      )
      .map((orderLine) => {
        const key = lineKey(orderLine.orderId, orderLine.lineId);
        const qty = matchedQty.get(key) ?? 0n;
        return {
          orderId: orderLine.orderId,
          lineId: orderLine.lineId,
          qualifiedQty: qualified.get(key) ?? 0n,
          matchedQty: qty,
          matchedAmountCents: matchedAmount.get(key) ?? 0n,
          baselineCents: roundHalfUpToCents(qty * orderLine.priceCents),
        };
      });
    return { invoices, lines };
  }

  private loadCache(): void {
    this.orderLines.clear();
    this.receipts.clear();
    this.invoices = [];
    const orderRows = this.db
      .prepare('SELECT order_id, line_id, currency, qty, price_cents FROM order_lines')
      .all() as Array<{
      order_id: string;
      line_id: string;
      currency: string;
      qty: string;
      price_cents: string;
    }>;
    for (const row of orderRows) {
      this.orderLines.set(lineKey(row.order_id, row.line_id), {
        orderId: row.order_id,
        lineId: row.line_id,
        currency: row.currency,
        qty: BigInt(row.qty),
        priceCents: BigInt(row.price_cents),
      });
    }
    const receiptRows = this.db.prepare('SELECT receipt_id, lines FROM receipts').all() as Array<{
      receipt_id: string;
      lines: string;
    }>;
    for (const row of receiptRows) {
      this.receipts.set(row.receipt_id, JSON.parse(row.lines) as NormalizedReceiptLine[]);
    }
    const invoiceRows = this.db
      .prepare('SELECT invoice_id, seq, voided, settled, lines FROM invoices ORDER BY seq')
      .all() as Array<{
      invoice_id: string;
      seq: number;
      voided: number;
      settled: number;
      lines: string;
    }>;
    for (const row of invoiceRows) {
      this.invoices.push({
        invoiceId: row.invoice_id,
        seq: row.seq,
        voided: row.voided !== 0,
        settled: row.settled !== 0,
        lines: JSON.parse(row.lines) as NormalizedInvoiceLine[],
      });
    }
  }

  private requireOrderLine(orderId: string, lineId: string): void {
    if (!this.orderLines.has(lineKey(orderId, lineId))) {
      throw new Error(`订单行不存在: ${orderId}/${lineId}`);
    }
  }

  private qualifiedQtyByLine(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const lines of this.receipts.values()) {
      for (const line of lines) {
        const key = lineKey(line.orderId, line.lineId);
        out.set(key, (out.get(key) ?? 0n) + BigInt(line.qualified));
      }
    }
    return out;
  }

  /** 依据当前有效数据重新分配，不保留旧匹配资格。 */
  private reallocate(): void {
    const orderLines = new Map<string, OrderLineState>();
    for (const [key, line] of this.orderLines) {
      orderLines.set(key, {
        orderId: line.orderId,
        lineId: line.lineId,
        qty: line.qty,
        priceCents: line.priceCents,
      });
    }
    const invoices: InvoiceState[] = this.invoices.map((inv) => {
      const merged = new Map<string, { qty: bigint; amountCents: bigint }>();
      for (const line of inv.lines) {
        const key = lineKey(line.orderId, line.lineId);
        const acc = merged.get(key) ?? { qty: 0n, amountCents: 0n };
        acc.qty += BigInt(line.qty);
        acc.amountCents += BigInt(line.amountCents);
        merged.set(key, acc);
      }
      return {
        invoiceId: inv.invoiceId,
        seq: inv.seq,
        voided: inv.voided,
        lines: [...merged.entries()].map(([key, acc]) => ({
          key,
          qty: acc.qty,
          amountCents: acc.amountCents,
        })),
      };
    });

    const settled = allocate(orderLines, this.qualifiedQtyByLine(), invoices);
    const update = this.db.prepare('UPDATE invoices SET settled = ? WHERE invoice_id = ?');
    for (const inv of this.invoices) {
      const next = settled.has(inv.invoiceId);
      if (next !== inv.settled) {
        update.run(next ? 1 : 0, inv.invoiceId);
        inv.settled = next;
      }
    }
  }

  /**
   * 带全库唯一业务操作号的写入：
   * 同号同内容重试无任何副作用；同号不同内容抛出且不改数据。
   * 整个写入（含重新分配）在单事务内完成，返回即可见；
   * 单进程内同步执行使并发写入自然串行化。
   */
  private runOp(opId: string, kind: string, payload: unknown, apply: () => void): void {
    const payloadJson = JSON.stringify(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT kind, payload FROM ops WHERE op_id = ?')
        .get(opId) as { kind: string; payload: string } | undefined;
      if (existing !== undefined) {
        if (existing.kind !== kind || existing.payload !== payloadJson) {
          throw new OpConflictError(opId);
        }
        this.db.exec('COMMIT');
        return;
      }
      apply();
      this.reallocate();
      this.db
        .prepare('INSERT INTO ops (op_id, kind, payload) VALUES (?, ?, ?)')
        .run(opId, kind, payloadJson);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.loadCache();
      throw err;
    }
  }
}
