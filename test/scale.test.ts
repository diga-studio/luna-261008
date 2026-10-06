import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  ReconciliationLibrary,
  type EngineInvoice,
  type EngineLine,
  type InvoiceInput,
} from '../src/index.js';

// 非功能指标：2000 张发票、每票 20 行、20 路并发写入
test('规模：2000 张发票 x 20 行，20 路并发写入，快照与独立重算一致', { timeout: 120000 }, async () => {
  const NLINES = 20;
  const N = 2000;
  const CONCURRENCY = 20;
  const lib = ReconciliationLibrary.open(':memory:');
  await lib.registerPurchaseOrder('op-po', {
    poId: 'PO1',
    currency: 'CNY',
    lines: Array.from({ length: NLINES }, (_, i) => ({
      lineId: `L${i}`,
      orderedQty: 100000000n,
      unitPrice: 100n,
    })),
  });
  await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: Array.from({ length: NLINES }, (_, i) => ({
      poId: 'PO1',
      poLineId: `L${i}`,
      qtyQualified: 100000000n,
      qtyPending: 0n,
      qtyRejected: 0n,
    })),
  });

  const invoices: InvoiceInput[] = Array.from({ length: N }, (_, i) => ({
    invoiceId: `INV-${i}`,
    currency: 'CNY',
    lines: Array.from({ length: NLINES }, (_, j) => ({
      poId: 'PO1',
      poLineId: `L${j}`,
      qty: 10000n,
      amount: 1000n,
    })),
  }));

  // 20 路并发写入
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < N) {
      const i = cursor++;
      const r = await lib.registerInvoice(`op-i-${i}`, invoices[i]!);
      assert.equal(r.status, 'applied');
    }
  });
  await Promise.all(workers);

  const snap = lib.getSnapshot();
  assert.equal(snap.invoices.length, N);
  // 全部可结算（额度充足），核销总量 = 2000 * 10000
  assert.ok(snap.invoices.every((i) => i.state === 'settleable'));
  for (const l of snap.lines) {
    assert.equal(l.matchedQty, 10000n * BigInt(N));
    assert.equal(l.matchedAmount, 1000n * BigInt(N));
  }

  // 与独立重算一致
  const seqById = new Map(snap.invoices.map((i) => [i.invoiceId, i.seq]));
  const engineLines: EngineLine[] = snap.lines.map((l) => ({
    poId: l.poId,
    poLineId: l.poLineId,
    orderedQty: l.orderedQty,
    unitPrice: l.unitPrice,
    qualifiedQty: l.qualifiedQty,
  }));
  const engineInvoices: EngineInvoice[] = invoices.map((inv) => ({
    invoiceId: inv.invoiceId,
    seq: seqById.get(inv.invoiceId)!,
    voided: false,
    lines: inv.lines.map((l) => ({ ...l })),
  }));
  const result = allocate(engineLines, engineInvoices);
  for (const inv of snap.invoices) {
    assert.equal(inv.state, result.invoiceState.get(inv.invoiceId));
  }
  lib.close();
});
