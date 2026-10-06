import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReconciliationLibrary, type Snapshot } from '../src/index.js';

async function newLib(): Promise<ReconciliationLibrary> {
  return ReconciliationLibrary.open(':memory:');
}

async function setupPo(
  lib: ReconciliationLibrary,
  lines: { lineId: string; orderedQty: bigint; unitPrice: bigint }[],
): Promise<void> {
  const r = await lib.registerPurchaseOrder('op-po', {
    poId: 'PO1',
    currency: 'CNY',
    lines,
  });
  assert.equal(r.status, 'applied');
}

function invoiceState(snap: Snapshot, invoiceId: string): string {
  return snap.invoices.find((i) => i.invoiceId === invoiceId)!.state;
}

function lineSnap(snap: Snapshot, poLineId: string) {
  return snap.lines.find((l) => l.poLineId === poLineId)!;
}

test('多行票只差一行不满足：整票待匹配，不占任何额度', async () => {
  const lib = await newLib();
  await setupPo(lib, [
    { lineId: 'L1', orderedQty: 10000n, unitPrice: 100n },
    { lineId: 'L2', orderedQty: 10000n, unitPrice: 100n },
  ]);
  await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: [
      { poId: 'PO1', poLineId: 'L1', qtyQualified: 10000n, qtyPending: 0n, qtyRejected: 0n },
      { poId: 'PO1', poLineId: 'L2', qtyQualified: 10000n, qtyPending: 0n, qtyRejected: 0n },
    ],
  });
  // L1 行金额正常，L2 行金额偏差 4% > 2%
  const r = await lib.registerInvoice('op-i1', {
    invoiceId: 'INV1',
    currency: 'CNY',
    lines: [
      { poId: 'PO1', poLineId: 'L1', qty: 5000n, amount: 500n },
      { poId: 'PO1', poLineId: 'L2', qty: 5000n, amount: 520n },
    ],
  });
  assert.equal(r.status, 'applied');
  const snap = lib.getSnapshot();
  assert.equal(invoiceState(snap, 'INV1'), 'pending');
  assert.equal(lineSnap(snap, 'L1').matchedQty, 0n);
  assert.equal(lineSnap(snap, 'L1').matchedAmount, 0n);
  assert.equal(lineSnap(snap, 'L2').matchedQty, 0n);
  lib.close();
});

test('累计 105% 边界：等于边界可核销，超出不可', async () => {
  const lib = await newLib();
  await setupPo(lib, [{ lineId: 'L1', orderedQty: 10000n, unitPrice: 100n }]);
  await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: [{ poId: 'PO1', poLineId: 'L1', qtyQualified: 10000n, qtyPending: 0n, qtyRejected: 0n }],
  });
  // 恰好订购量的 105%
  await lib.registerInvoice('op-i1', {
    invoiceId: 'INV1',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 10500n, amount: 10500n * 100n / 1000n }],
  });
  // 再开 1 千分之一单位即超出
  await lib.registerInvoice('op-i2', {
    invoiceId: 'INV2',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 1n, amount: 0n }],
  });
  const snap = lib.getSnapshot();
  assert.equal(invoiceState(snap, 'INV1'), 'settleable');
  assert.equal(invoiceState(snap, 'INV2'), 'pending');
  assert.equal(lineSnap(snap, 'L1').matchedQty, 10500n);
  lib.close();
});

test('收货更正减少合格量后：原可结算票回到待匹配，资格转移给更晚候选；旧更正重放无效', async () => {
  const lib = await newLib();
  await setupPo(lib, [{ lineId: 'L1', orderedQty: 10000n, unitPrice: 100n }]);
  await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: [{ poId: 'PO1', poLineId: 'L1', qtyQualified: 10000n, qtyPending: 0n, qtyRejected: 0n }],
  });
  await lib.registerInvoice('op-i1', {
    invoiceId: 'INV1',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 10000n, amount: 1000n }],
  });
  await lib.registerInvoice('op-i2', {
    invoiceId: 'INV2',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 500n, amount: 50n }],
  });
  let snap = lib.getSnapshot();
  assert.equal(invoiceState(snap, 'INV1'), 'settleable');
  assert.equal(invoiceState(snap, 'INV2'), 'settleable');

  // 更正：合格量降到 9000，105% 上限变为 9450
  await lib.recordReceipt('op-r2', {
    receiptId: 'R1',
    lines: [{ poId: 'PO1', poLineId: 'L1', qtyQualified: 9000n, qtyPending: 500n, qtyRejected: 500n }],
  });
  snap = lib.getSnapshot();
  assert.equal(lineSnap(snap, 'L1').qualifiedQty, 9000n);
  // INV1 票量 10000 > 9450 失去资格；INV2 仍满足，额度转移给它
  assert.equal(invoiceState(snap, 'INV1'), 'pending');
  assert.equal(invoiceState(snap, 'INV2'), 'settleable');
  assert.equal(lineSnap(snap, 'L1').matchedQty, 500n);
  assert.equal(lineSnap(snap, 'L1').matchedAmount, 50n);

  // 重放旧收货（op-r1）：同号同内容 -> duplicate，不覆盖新状态
  const dup = await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: [{ poId: 'PO1', poLineId: 'L1', qtyQualified: 10000n, qtyPending: 0n, qtyRejected: 0n }],
  });
  assert.equal(dup.status, 'duplicate');
  snap = lib.getSnapshot();
  assert.equal(lineSnap(snap, 'L1').qualifiedQty, 9000n);
  assert.equal(invoiceState(snap, 'INV1'), 'pending');
  lib.close();
});

test('小额分票：单票通过但累计 2% 不通过；后续票加入后早票重新具备资格', async () => {
  const lib = await newLib();
  await setupPo(lib, [{ lineId: 'L1', orderedQty: 100000n, unitPrice: 1n }]);
  await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: [{ poId: 'PO1', poLineId: 'L1', qtyQualified: 100000n, qtyPending: 0n, qtyRejected: 0n }],
  });
  // 每张小票：票量 1333 -> 基准 round(1.333)=1，金额 1，单票偏差 0
  await lib.registerInvoice('op-i1', {
    invoiceId: 'INV1',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 1333n, amount: 1n }],
  });
  await lib.registerInvoice('op-i2', {
    invoiceId: 'INV2',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 1333n, amount: 1n }],
  });
  let snap = lib.getSnapshot();
  assert.equal(invoiceState(snap, 'INV1'), 'settleable');
  // 累计票量 2666 -> 基准 3，累计金额 2，偏差 1 分 > 2% -> INV2 待匹配
  assert.equal(invoiceState(snap, 'INV2'), 'pending');

  // 加入 INV3（票量 2667 -> 基准 3，金额 3）：与 INV1 合计 4000 -> 基准 4，金额 4，通过
  await lib.registerInvoice('op-i3', {
    invoiceId: 'INV3',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 2667n, amount: 3n }],
  });
  snap = lib.getSnapshot();
  assert.equal(invoiceState(snap, 'INV3'), 'settleable');
  // 早票 INV2 重新具备资格：累计 5333 -> 基准 5，金额 5，偏差 0
  assert.equal(invoiceState(snap, 'INV2'), 'settleable');
  assert.equal(lineSnap(snap, 'L1').matchedQty, 5333n);
  assert.equal(lineSnap(snap, 'L1').matchedAmount, 5n);
  lib.close();
});

test('少开票不要求耗尽收货；待检/不合格数量不提供额度', async () => {
  const lib = await newLib();
  await setupPo(lib, [{ lineId: 'L1', orderedQty: 10000n, unitPrice: 100n }]);
  await lib.recordReceipt('op-r1', {
    receiptId: 'R1',
    lines: [{ poId: 'PO1', poLineId: 'L1', qtyQualified: 2000n, qtyPending: 5000n, qtyRejected: 3000n }],
  });
  await lib.registerInvoice('op-i1', {
    invoiceId: 'INV1',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 1000n, amount: 100n }],
  });
  // 票量 2001 超过合格量 2000 的 105%（2100）？否：2001 <= 2100 可核销；用 2101 超出
  await lib.registerInvoice('op-i2', {
    invoiceId: 'INV2',
    currency: 'CNY',
    lines: [{ poId: 'PO1', poLineId: 'L1', qty: 1101n, amount: 110n }],
  });
  const snap = lib.getSnapshot();
  assert.equal(invoiceState(snap, 'INV1'), 'settleable'); // 少开不要求耗尽
  // 累计 2101 > 2100 -> INV2 待匹配
  assert.equal(invoiceState(snap, 'INV2'), 'pending');
  lib.close();
});
