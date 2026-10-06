import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { allocate, type AllocationResult, type EngineInvoice, type EngineLine } from './engine.js';
import type {
  InvoiceInput,
  PurchaseOrderInput,
  ReceiptInput,
  Snapshot,
  WriteResult,
} from './types.js';

const MAX_ABS = 10n ** 18n; // 单个数值最多 18 位

function checkInt(name: string, v: bigint): void {
  if (typeof v !== 'bigint') throw new Error(`${name} 必须是 bigint`);
  if (v < 0n) throw new Error(`${name} 不能为负`);
  if (v >= MAX_ABS) throw new Error(`${name} 超过 18 位`);
}

/** 规范化序列化：键排序、bigint 转字符串，用于同号同内容比较。 */
function canonical(value: unknown): string {
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class ReconciliationLibrary {
  private constructor(private readonly db: DatabaseSync) {}

  private queue: Promise<unknown> = Promise.resolve();

  /** 引擎输入缓存：本实例是唯一写者， applied 写操作后失效。 */
  private engineLinesCache: EngineLine[] | null = null;
  private engineInvoicesCache: EngineInvoice[] | null = null;
  /** 上一次分配结果，用于差量持久化。 */
  private lastAllocation: AllocationResult | null = null;

  static open(path: string): ReconciliationLibrary {
    return new ReconciliationLibrary(openDatabase(path));
  }

  /** 串行化所有写操作：并发结果等价于某个保持完成顺序的串行执行。 */
  private enqueue<T>(fn: () => T): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * 幂等闸门：同号同内容 → 'duplicate'（无副作用）；
   * 同号不同内容 → 'conflict'（数据不变）；否则执行 apply 并登记操作号。
   */
  private withOp(opId: string, opType: string, payload: unknown, apply: () => void): WriteResult {
    if (!opId) throw new Error('opId 不能为空');
    const body = canonical(payload);
    const existing = this.db
      .prepare('SELECT op_type, payload FROM ops WHERE op_id = ?')
      .get(opId) as { op_type: string; payload: string } | undefined;
    if (existing) {
      if (existing.op_type === opType && existing.payload === body) {
        return { status: 'duplicate' };
      }
      return { status: 'conflict' };
    }
    this.db.exec('BEGIN');
    try {
      apply();
      this.db.prepare('INSERT INTO ops (op_id, op_type, payload) VALUES (?, ?, ?)').run(
        opId,
        opType,
        body,
      );
      this.recompute();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      // 回滚后内存缓存可能与库内数据不一致，全部失效
      this.engineLinesCache = null;
      this.engineInvoicesCache = null;
      this.lastAllocation = null;
      throw err;
    }
    return { status: 'applied' };
  }

  registerPurchaseOrder(opId: string, po: PurchaseOrderInput): Promise<WriteResult> {
    return this.enqueue(() =>
      this.withOp(opId, 'po', po, () => {
        if (!po.poId) throw new Error('poId 不能为空');
        if (!po.lines.length) throw new Error('采购订单至少一行');
        const seen = new Set<string>();
        for (const l of po.lines) {
          if (seen.has(l.lineId)) throw new Error(`订单行重复: ${l.lineId}`);
          seen.add(l.lineId);
          checkInt('orderedQty', l.orderedQty);
          checkInt('unitPrice', l.unitPrice);
        }
        const dup = this.db
          .prepare('SELECT po_id FROM purchase_orders WHERE po_id = ?')
          .get(po.poId);
        if (dup) throw new Error(`采购订单已存在: ${po.poId}`);
        this.db
          .prepare('INSERT INTO purchase_orders (po_id, currency) VALUES (?, ?)')
          .run(po.poId, po.currency);
        const ins = this.db.prepare(
          'INSERT INTO po_lines (po_id, line_id, ordered_qty, unit_price) VALUES (?, ?, ?, ?)',
        );
        for (const l of po.lines) {
          ins.run(po.poId, l.lineId, l.orderedQty.toString(), l.unitPrice.toString());
        }
        if (this.engineLinesCache) {
          for (const l of po.lines) {
            this.engineLinesCache.push({
              poId: po.poId,
              poLineId: l.lineId,
              orderedQty: l.orderedQty,
              unitPrice: l.unitPrice,
              qualifiedQty: 0n,
            });
          }
        }
      }),
    );
  }

  recordReceipt(opId: string, receipt: ReceiptInput): Promise<WriteResult> {
    return this.enqueue(() =>
      this.withOp(opId, 'receipt', receipt, () => {
        if (!receipt.receiptId) throw new Error('receiptId 不能为空');
        for (const l of receipt.lines) {
          this.requirePoLine(l.poId, l.poLineId);
          checkInt('qtyQualified', l.qtyQualified);
          checkInt('qtyPending', l.qtyPending);
          checkInt('qtyRejected', l.qtyRejected);
        }
        // 更正：替换该收货单原内容
        const oldLines = this.db
          .prepare('SELECT po_id AS poId, po_line_id AS poLineId, qty_qualified AS qty FROM receipt_lines WHERE receipt_id = ?')
          .all(receipt.receiptId) as unknown as { poId: string; poLineId: string; qty: string }[];
        this.db
          .prepare('INSERT OR IGNORE INTO receipts (receipt_id) VALUES (?)')
          .run(receipt.receiptId);
        this.db
          .prepare('DELETE FROM receipt_lines WHERE receipt_id = ?')
          .run(receipt.receiptId);
        const ins = this.db.prepare(
          'INSERT INTO receipt_lines (receipt_id, po_id, po_line_id, qty_qualified, qty_pending, qty_rejected) VALUES (?, ?, ?, ?, ?, ?)',
        );
        for (const l of receipt.lines) {
          ins.run(
            receipt.receiptId,
            l.poId,
            l.poLineId,
            l.qtyQualified.toString(),
            l.qtyPending.toString(),
            l.qtyRejected.toString(),
          );
        }
        if (this.engineLinesCache) {
          const delta = new Map<string, bigint>();
          for (const r of oldLines) {
            const k = `${r.poId}/${r.poLineId}`;
            delta.set(k, (delta.get(k) ?? 0n) - BigInt(r.qty));
          }
          for (const l of receipt.lines) {
            const k = `${l.poId}/${l.poLineId}`;
            delta.set(k, (delta.get(k) ?? 0n) + l.qtyQualified);
          }
          for (const line of this.engineLinesCache) {
            const d = delta.get(`${line.poId}/${line.poLineId}`);
            if (d !== undefined) line.qualifiedQty += d;
          }
        }
      }),
    );
  }

  registerInvoice(opId: string, invoice: InvoiceInput): Promise<WriteResult> {
    return this.enqueue(() =>
      this.withOp(opId, 'invoice', invoice, () => {
        if (!invoice.invoiceId) throw new Error('invoiceId 不能为空');
        if (!invoice.lines.length) throw new Error('发票至少一行');
        for (const l of invoice.lines) {
          const po = this.requirePoLine(l.poId, l.poLineId);
          if (po.currency !== invoice.currency) {
            throw new Error(`发票币种 ${invoice.currency} 与订单 ${l.poId} 币种 ${po.currency} 不一致`);
          }
          checkInt('qty', l.qty);
          checkInt('amount', l.amount);
        }
        const dup = this.db
          .prepare('SELECT invoice_id FROM invoices WHERE invoice_id = ?')
          .get(invoice.invoiceId);
        if (dup) throw new Error(`发票已存在: ${invoice.invoiceId}`);
        const seqRow = this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM invoices')
          .get() as { seq: number };
        this.db
          .prepare('INSERT INTO invoices (invoice_id, seq, currency, voided) VALUES (?, ?, ?, 0)')
          .run(invoice.invoiceId, seqRow.seq, invoice.currency);
        const ins = this.db.prepare(
          'INSERT INTO invoice_lines (invoice_id, po_id, po_line_id, qty, amount) VALUES (?, ?, ?, ?, ?)',
        );
        for (const l of invoice.lines) {
          ins.run(invoice.invoiceId, l.poId, l.poLineId, l.qty.toString(), l.amount.toString());
        }
        if (this.engineInvoicesCache) {
          this.engineInvoicesCache.push({
            invoiceId: invoice.invoiceId,
            seq: seqRow.seq,
            voided: false,
            lines: invoice.lines.map((l) => ({ ...l })),
          });
        }
      }),
    );
  }

  voidInvoice(opId: string, invoiceId: string): Promise<WriteResult> {
    return this.enqueue(() =>
      this.withOp(opId, 'void', { invoiceId }, () => {
        const row = this.db
          .prepare('SELECT invoice_id FROM invoices WHERE invoice_id = ?')
          .get(invoiceId);
        if (!row) throw new Error(`发票不存在: ${invoiceId}`);
        this.db.prepare('UPDATE invoices SET voided = 1 WHERE invoice_id = ?').run(invoiceId);
        if (this.engineInvoicesCache) {
          const inv = this.engineInvoicesCache.find((i) => i.invoiceId === invoiceId);
          if (inv) inv.voided = true;
        }
      }),
    );
  }

  private requirePoLine(poId: string, poLineId: string): { currency: string } {
    const row = this.db
      .prepare(
        'SELECT p.currency AS currency FROM po_lines l JOIN purchase_orders p ON p.po_id = l.po_id WHERE l.po_id = ? AND l.line_id = ?',
      )
      .get(poId, poLineId) as { currency: string } | undefined;
    if (!row) throw new Error(`订单行不存在: ${poId}/${poLineId}`);
    return row;
  }


  /** 各订单行当前合格收货量（JS 侧 bigint 求和，避免 SQLite SUM 溢出/精度丢失）。 */
  private qualifiedQtyByLine(): Map<string, bigint> {
    const rows = this.db
      .prepare('SELECT po_id AS poId, po_line_id AS poLineId, qty_qualified AS qty FROM receipt_lines')
      .all() as unknown as { poId: string; poLineId: string; qty: string }[];
    const map = new Map<string, bigint>();
    for (const r of rows) {
      const k = `${r.poId}/${r.poLineId}`;
      map.set(k, (map.get(k) ?? 0n) + BigInt(r.qty));
    }
    return map;
  }

  private loadEngineLines(): EngineLine[] {
    const qualified = this.qualifiedQtyByLine();
    return (
      this.db
        .prepare(
          'SELECT po_id AS poId, line_id AS poLineId, ordered_qty AS orderedQty, unit_price AS unitPrice FROM po_lines',
        )
        .all() as unknown as Record<string, string>[]
    ).map((r) => ({
      poId: r.poId,
      poLineId: r.poLineId,
      orderedQty: BigInt(r.orderedQty),
      unitPrice: BigInt(r.unitPrice),
      qualifiedQty: qualified.get(`${r.poId}/${r.poLineId}`) ?? 0n,
    }));
  }

  private loadEngineInvoices(): EngineInvoice[] {
    const invRows = this.db
      .prepare('SELECT invoice_id AS invoiceId, seq, voided FROM invoices')
      .all() as unknown as { invoiceId: string; seq: number; voided: number }[];
    const lineRows = this.db
      .prepare('SELECT invoice_id AS invoiceId, po_id AS poId, po_line_id AS poLineId, qty, amount FROM invoice_lines')
      .all() as unknown as {
      invoiceId: string;
      poId: string;
      poLineId: string;
      qty: string;
      amount: string;
    }[];
    const byInvoice = new Map<string, EngineInvoice>();
    for (const r of invRows) {
      byInvoice.set(r.invoiceId, {
        invoiceId: r.invoiceId,
        seq: r.seq,
        voided: r.voided !== 0,
        lines: [],
      });
    }
    for (const r of lineRows) {
      byInvoice.get(r.invoiceId)!.lines.push({
        poId: r.poId,
        poLineId: r.poLineId,
        qty: BigInt(r.qty),
        amount: BigInt(r.amount),
      });
    }
    return [...byInvoice.values()];
  }

  /** 按当前有效数据重算分配并持久化结果（在写事务内调用）。 */
  private recompute(): void {
    const lines = (this.engineLinesCache ??= this.loadEngineLines());
    const invoices = (this.engineInvoicesCache ??= this.loadEngineInvoices());
    const result = allocate(lines, invoices);
    const prev = this.lastAllocation;

    if (!prev) {
      // 打开后首次重算：全量重建，清除可能的陈旧数据
      this.db.exec('DELETE FROM invoice_state');
      this.db.exec('DELETE FROM line_allocation');
    }
    const insState = this.db.prepare(
      'INSERT OR REPLACE INTO invoice_state (invoice_id, state) VALUES (?, ?)',
    );
    for (const [invoiceId, state] of result.invoiceState) {
      if (prev && prev.invoiceState.get(invoiceId) === state) continue;
      insState.run(invoiceId, state);
    }
    const insAlloc = this.db.prepare(
      'INSERT OR REPLACE INTO line_allocation (po_id, po_line_id, matched_qty, matched_amount) VALUES (?, ?, ?, ?)',
    );
    for (const l of lines) {
      const k = `${l.poId}/${l.poLineId}`;
      const qty = result.matchedQty.get(k) ?? 0n;
      const amount = result.matchedAmount.get(k) ?? 0n;
      if (prev && prev.matchedQty.get(k) === qty && prev.matchedAmount.get(k) === amount) {
        continue;
      }
      insAlloc.run(l.poId, l.poLineId, qty.toString(), amount.toString());
    }
    this.lastAllocation = result;
  }

  getSnapshot(): Snapshot {
    const invoices = (
      this.db
        .prepare(
          `SELECT i.invoice_id AS invoiceId, i.seq AS seq, s.state AS state
           FROM invoices i JOIN invoice_state s ON s.invoice_id = i.invoice_id
           ORDER BY i.seq`,
        )
        .all() as unknown as { invoiceId: string; seq: number; state: Snapshot['invoices'][number]['state'] }[]
    ).map((r) => ({ invoiceId: r.invoiceId, seq: r.seq, state: r.state }));

    const qualified = this.qualifiedQtyByLine();
    const lines = (
      this.db
        .prepare(
          `SELECT l.po_id AS poId, l.line_id AS poLineId, l.ordered_qty AS orderedQty, l.unit_price AS unitPrice,
                  a.matched_qty AS matchedQty, a.matched_amount AS matchedAmount
           FROM po_lines l
           JOIN line_allocation a ON a.po_id = l.po_id AND a.po_line_id = l.line_id
           ORDER BY l.po_id, l.line_id`,
        )
        .all() as unknown as Record<string, string>[]
    ).map((r) => ({
      poId: r.poId,
      poLineId: r.poLineId,
      orderedQty: BigInt(r.orderedQty),
      unitPrice: BigInt(r.unitPrice),
      qualifiedQty: qualified.get(`${r.poId}/${r.poLineId}`) ?? 0n,
      matchedQty: BigInt(r.matchedQty),
      matchedAmount: BigInt(r.matchedAmount),
    }));

    return { invoices, lines };
  }

  close(): void {
    this.db.close();
  }
}
