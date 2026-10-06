import assert from 'node:assert/strict';
import test from 'node:test';
import { ReconciliationStore, type Snapshot } from '../src/index.js';
import { freshDbPath } from './helpers.js';

function lineOf(snap: Snapshot, lineId: string) {
  const line = snap.lines.find((l) => l.lineId === lineId);
  assert.ok(line, `快照缺少订单行 ${lineId}`);
  return line;
}

function statusOf(snap: Snapshot, invoiceId: string) {
  const inv = snap.invoices.find((i) => i.invoiceId === invoiceId);
  assert.ok(inv, `快照缺少发票 ${invoiceId}`);
  return inv.status;
}

test('多行票只差一行不满足时整票不占额', () => {
  const store = ReconciliationStore.open(freshDbPath());
  store.registerOrder('op-order', {
    orderId: 'O1',
    currency: 'CNY',
    lines: [
      { lineId: 'L1', qty: 100_000, priceCents: 100 },
      { lineId: 'L2', qty: 50_000, priceCents: 200 },
    ],
  });
  store.registerReceipt('op-rcpt', {
    receiptId: 'R1',
    lines: [
      { orderId: 'O1', lineId: 'L1', qualified: 100_000, pending: 0, unqualified: 0 },
      { orderId: 'O1', lineId: 'L2', qualified: 50_000, pending: 0, unqualified: 0 },
    ],
  });
  // L1 行金额吻合（10000 千分之一单位 × 100 分 = 1000 分），L2 行严重偏离：整票待匹配。
  store.registerInvoice('op-inv-bad', {
    invoiceId: 'I-BAD',
    lines: [
      { orderId: 'O1', lineId: 'L1', qty: 10_000, amountCents: 1_000 },
      { orderId: 'O1', lineId: 'L2', qty: 1_000, amountCents: 5_000 },
    ],
  });
  store.registerInvoice('op-inv-good', {
    invoiceId: 'I-GOOD',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 10_000, amountCents: 1_000 }],
  });

  const snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I-BAD'), 'PENDING');
  assert.equal(statusOf(snap, 'I-GOOD'), 'SETTLED');
  assert.equal(lineOf(snap, 'L1').matchedQty, 10_000n);
  assert.equal(lineOf(snap, 'L1').matchedAmountCents, 1_000n);
  assert.equal(lineOf(snap, 'L2').matchedQty, 0n);
  store.close();
});

test('同票指向同一订单行的多行先合计再判断', () => {
  const store = ReconciliationStore.open(freshDbPath());
  store.registerOrder('op-order', {
    orderId: 'O1',
    currency: 'CNY',
    lines: [{ lineId: 'L1', qty: 100_000, priceCents: 3 }],
  });
  store.registerReceipt('op-rcpt', {
    receiptId: 'R1',
    lines: [{ orderId: 'O1', lineId: 'L1', qualified: 100_000, pending: 0, unqualified: 0 }],
  });
  // 单行基准 1.5 分舍入为 2 分都吻合；合计票量 1000 的基准为 3 分，合计 4 分超差。
  store.registerInvoice('op-inv', {
    invoiceId: 'I-SPLIT',
    lines: [
      { orderId: 'O1', lineId: 'L1', qty: 500, amountCents: 2 },
      { orderId: 'O1', lineId: 'L1', qty: 500, amountCents: 2 },
    ],
  });
  const snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I-SPLIT'), 'PENDING');
  assert.equal(lineOf(snap, 'L1').matchedQty, 0n);
  store.close();
});

test('累计核销票量 105% 边界：等于可核销，超出不可', () => {
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
  // 恰好 105%（10500/10000）：可核销。基准 1050 分。
  store.registerInvoice('op-inv-edge', {
    invoiceId: 'I-EDGE',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 10_500, amountCents: 1_050 }],
  });
  // 再增加 1 千分之一单位即越界（基准 0.1 分舍入为 0，金额只能为 0）。
  store.registerInvoice('op-inv-over', {
    invoiceId: 'I-OVER',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1, amountCents: 0 }],
  });
  const snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I-EDGE'), 'SETTLED');
  assert.equal(statusOf(snap, 'I-OVER'), 'PENDING');
  assert.equal(lineOf(snap, 'L1').matchedQty, 10_500n);
  store.close();
});

test('合格收货量的 105% 同样构成边界', () => {
  const store = ReconciliationStore.open(freshDbPath());
  store.registerOrder('op-order', {
    orderId: 'O1',
    currency: 'CNY',
    lines: [{ lineId: 'L1', qty: 100_000, priceCents: 100 }],
  });
  // 订购量充足，但合格收货只有 5000（105% 上限 5250）。
  store.registerReceipt('op-rcpt', {
    receiptId: 'R1',
    lines: [{ orderId: 'O1', lineId: 'L1', qualified: 5_000, pending: 3_000, unqualified: 2_000 }],
  });
  store.registerInvoice('op-inv-edge', {
    invoiceId: 'I-EDGE',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 5_250, amountCents: 525 }],
  });
  store.registerInvoice('op-inv-over', {
    invoiceId: 'I-OVER',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1, amountCents: 0 }],
  });
  const snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I-EDGE'), 'SETTLED');
  assert.equal(statusOf(snap, 'I-OVER'), 'PENDING');
  assert.equal(lineOf(snap, 'L1').qualifiedQty, 5_000n);
  store.close();
});

test('收货更正减少合格量后资格按优先级转移', () => {
  const store = ReconciliationStore.open(freshDbPath());
  store.registerOrder('op-order', {
    orderId: 'O1',
    currency: 'CNY',
    lines: [{ lineId: 'L1', qty: 100_000, priceCents: 100 }],
  });
  store.registerReceipt('op-rcpt-v1', {
    receiptId: 'R1',
    lines: [{ orderId: 'O1', lineId: 'L1', qualified: 100_000, pending: 0, unqualified: 0 }],
  });
  store.registerInvoice('op-inv-1', {
    invoiceId: 'I1',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 60_000, amountCents: 6_000 }],
  });
  store.registerInvoice('op-inv-2', {
    invoiceId: 'I2',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 45_000, amountCents: 4_500 }],
  });
  store.registerInvoice('op-inv-3', {
    invoiceId: 'I3',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 13_000, amountCents: 1_300 }],
  });

  let snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I1'), 'SETTLED');
  assert.equal(statusOf(snap, 'I2'), 'SETTLED'); // 60000+45000 = 105% 边界
  assert.equal(statusOf(snap, 'I3'), 'PENDING');

  // 更正收货：合格量降到 70000（105% 上限 73500）。
  store.registerReceipt('op-rcpt-v2', {
    receiptId: 'R1',
    lines: [{ orderId: 'O1', lineId: 'L1', qualified: 70_000, pending: 0, unqualified: 0 }],
  });
  snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I1'), 'SETTLED');
  assert.equal(statusOf(snap, 'I2'), 'PENDING'); // 60000+45000=105000 > 73500
  assert.equal(statusOf(snap, 'I3'), 'SETTLED'); // 60000+13000=73000 ≤ 73500
  assert.equal(lineOf(snap, 'L1').qualifiedQty, 70_000n);
  assert.equal(lineOf(snap, 'L1').matchedQty, 73_000n);
  store.close();
});
