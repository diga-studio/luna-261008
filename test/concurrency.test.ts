import assert from 'node:assert/strict';
import test from 'node:test';
import { ReconciliationStore, type InvoiceInput, type Snapshot } from '../src/index.js';
import { freshDbPath, referenceSnapshot, type RefInvoice, type RefOrderLine } from './helpers.js';

const ORDER = {
  orderId: 'O1',
  currency: 'CNY',
  lines: [
    { lineId: 'L1', qty: 100_000, priceCents: 100 },
    { lineId: 'L2', qty: 80_000, priceCents: 50 },
  ],
};

function invoice(id: string, qty: number, amountCents: number): InvoiceInput {
  return {
    invoiceId: id,
    lines: [{ orderId: 'O1', lineId: 'L1', qty, amountCents }],
  };
}

/** 依据测试记录的有效数据独立重算，并与库快照逐字段比对。 */
function assertConsistent(
  snap: Snapshot,
  invoices: readonly RefInvoice[],
  qualified: ReadonlyMap<string, bigint>,
) {
  const orderLines: RefOrderLine[] = ORDER.lines.map((l) => ({
    orderId: 'O1',
    lineId: l.lineId,
    qty: BigInt(l.qty),
    priceCents: BigInt(l.priceCents),
  }));
  assert.deepEqual(snap, referenceSnapshot(orderLines, qualified, invoices));
}

test('并发登记、撤票与旧操作重试，最终快照与独立计算一致', async () => {
  const path = freshDbPath();
  let store = ReconciliationStore.open(path);
  store.registerOrder('op-order', ORDER);
  store.registerReceipt('op-rcpt-v1', {
    receiptId: 'R1',
    lines: [
      { orderId: 'O1', lineId: 'L1', qualified: 100_000, pending: 0, unqualified: 0 },
      { orderId: 'O1', lineId: 'L2', qualified: 80_000, pending: 0, unqualified: 0 },
    ],
  });

  // 20 个并发写入：每张票 qty 1000、金额 100（与基准吻合）。
  const inputs = Array.from({ length: 20 }, (_, i) => ({
    opId: `op-inv-${i}`,
    data: invoice(`INV-${i}`, 1_000, 100),
  }));
  await Promise.all(
    inputs.map(({ opId, data }) => Promise.resolve().then(() => store.registerInvoice(opId, data))),
  );

  let snap = store.getSnapshot();
  assert.equal(snap.invoices.length, 20);
  assert.deepEqual(
    snap.invoices.map((i) => i.seq).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  assert.ok(snap.invoices.every((i) => i.status === 'SETTLED'));

  // 并发撤票。
  await Promise.all(
    ['INV-3', 'INV-7'].map((id, k) =>
      Promise.resolve().then(() => store.voidInvoice(`op-void-${k}`, id)),
    ),
  );
  snap = store.getSnapshot();
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'INV-3')?.status, 'VOIDED');
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'INV-7')?.status, 'VOIDED');

  // 同号同内容重试：无新增副作用，不改变登记顺序，不复活撤销票。
  store.registerInvoice('op-inv-5', invoice('INV-5', 1_000, 100));
  store.registerInvoice('op-inv-3', invoice('INV-3', 1_000, 100));
  store.voidInvoice('op-void-0', 'INV-3');
  snap = store.getSnapshot();
  assert.equal(snap.invoices.length, 20);
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'INV-3')?.status, 'VOIDED');
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'INV-5')?.status, 'SETTLED');

  // 同号不同内容：抛出且数据不变。
  const before = store.getSnapshot();
  assert.throws(() => store.registerInvoice('op-inv-5', invoice('INV-5', 2_000, 200)));
  assert.throws(() => store.voidInvoice('op-inv-5', 'INV-5'));
  assert.deepEqual(store.getSnapshot(), before);

  // 收货更正后，旧更正操作重放不得覆盖新状态。
  store.registerReceipt('op-rcpt-v2', {
    receiptId: 'R1',
    lines: [
      { orderId: 'O1', lineId: 'L1', qualified: 50_000, pending: 0, unqualified: 0 },
      { orderId: 'O1', lineId: 'L2', qualified: 80_000, pending: 0, unqualified: 0 },
    ],
  });
  store.registerReceipt('op-rcpt-v1', {
    receiptId: 'R1',
    lines: [
      { orderId: 'O1', lineId: 'L1', qualified: 100_000, pending: 0, unqualified: 0 },
      { orderId: 'O1', lineId: 'L2', qualified: 80_000, pending: 0, unqualified: 0 },
    ],
  });
  snap = store.getSnapshot();
  assert.equal(snap.lines.find((l) => l.lineId === 'L1')?.qualifiedQty, 50_000n);

  // 依据当前有效数据独立重算并比对。
  const refInvoices: RefInvoice[] = snap.invoices.map((inv) => {
    const src = inputs.find((i) => i.data.invoiceId === inv.invoiceId);
    assert.ok(src, `未知发票 ${inv.invoiceId}`);
    return {
      invoiceId: inv.invoiceId,
      seq: inv.seq,
      voided: inv.status === 'VOIDED',
      lines: src.data.lines.map((l) => ({
        orderId: l.orderId,
        lineId: l.lineId,
        qty: BigInt(l.qty),
        amountCents: BigInt(l.amountCents),
      })),
    };
  });
  const qualified = new Map([
    [JSON.stringify(['O1', 'L1']), 50_000n],
    [JSON.stringify(['O1', 'L2']), 80_000n],
  ]);
  assertConsistent(snap, refInvoices, qualified);

  // 正常关闭再打开，结果不变。
  store.close();
  store = ReconciliationStore.open(path);
  snap = store.getSnapshot();
  assertConsistent(snap, refInvoices, qualified);
  store.close();
});

test('撤票后额度释放，后续票按优先级补上', () => {
  const store = ReconciliationStore.open(freshDbPath());
  store.registerOrder('op-order', {
    orderId: 'O1',
    currency: 'CNY',
    lines: [{ lineId: 'L1', qty: 10_000, priceCents: 100 }],
  });
  store.registerReceipt('op-rcpt', {
    receiptId: 'R1',
    lines: [{ orderId: 'O1', lineId: 'L1', qualified: 10_000, pending: 0, unqualified: 0 }],
  });
  store.registerInvoice('op-inv-1', {
    invoiceId: 'I1',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 10_500, amountCents: 1_050 }],
  });
  store.registerInvoice('op-inv-2', {
    invoiceId: 'I2',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 10_500, amountCents: 1_050 }],
  });
  let snap = store.getSnapshot();
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'I1')?.status, 'SETTLED');
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'I2')?.status, 'PENDING');

  store.voidInvoice('op-void-1', 'I1');
  snap = store.getSnapshot();
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'I1')?.status, 'VOIDED');
  assert.equal(snap.invoices.find((i) => i.invoiceId === 'I2')?.status, 'SETTLED');
  assert.equal(snap.lines[0]?.matchedQty, 10_500n);
  store.close();
});
