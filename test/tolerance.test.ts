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

function setup(priceCents: number): ReconciliationStore {
  const store = ReconciliationStore.open(freshDbPath());
  store.registerOrder('op-order', {
    orderId: 'O1',
    currency: 'CNY',
    lines: [{ lineId: 'L1', qty: 100_000, priceCents }],
  });
  store.registerReceipt('op-rcpt', {
    receiptId: 'R1',
    lines: [{ orderId: 'O1', lineId: 'L1', qualified: 100_000, pending: 0, unqualified: 0 }],
  });
  return store;
}

test('小额分票：单票 2% 通过但累计 2% 不通过', () => {
  const store = setup(1);
  // 票量 1500 的基准为 1.5 分，恰好半分向上舍入为 2 分；单票金额 2 分吻合。
  store.registerInvoice('op-inv-1', {
    invoiceId: 'I1',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1_500, amountCents: 2 }],
  });
  let snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I1'), 'SETTLED');
  assert.equal(lineOf(snap, 'L1').baselineCents, 2n); // 半分向上

  // 第二票同样单票吻合，但累计票量 3000 的基准为 3 分，累计 4 分超差。
  store.registerInvoice('op-inv-2', {
    invoiceId: 'I2',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1_500, amountCents: 2 }],
  });
  snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I1'), 'SETTLED');
  assert.equal(statusOf(snap, 'I2'), 'PENDING');
  assert.equal(lineOf(snap, 'L1').matchedQty, 1_500n);
  assert.equal(lineOf(snap, 'L1').matchedAmountCents, 2n);
  store.close();
});

test('后续票加入后早票重新具备资格', () => {
  const store = setup(1);
  store.registerInvoice('op-inv-1', {
    invoiceId: 'I1',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1_500, amountCents: 2 }],
  });
  store.registerInvoice('op-inv-2', {
    invoiceId: 'I2',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1_500, amountCents: 2 }],
  });
  let snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I1'), 'SETTLED');
  assert.equal(statusOf(snap, 'I2'), 'PENDING'); // 累计 4 分对基准 3 分超差

  // I3 单票吻合（基准 50 分，49 分在 2% 内），加入后拉平累计偏差：
  // I1+I3 累计 51 分对基准 52 分吻合，随后 I2 累计 53 分对基准 53 分也吻合。
  store.registerInvoice('op-inv-3', {
    invoiceId: 'I3',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 50_000, amountCents: 49 }],
  });
  snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I1'), 'SETTLED');
  assert.equal(statusOf(snap, 'I2'), 'SETTLED');
  assert.equal(statusOf(snap, 'I3'), 'SETTLED');
  assert.equal(lineOf(snap, 'L1').matchedQty, 53_000n);
  assert.equal(lineOf(snap, 'L1').matchedAmountCents, 53n);
  assert.equal(lineOf(snap, 'L1').baselineCents, 53n);
  store.close();
});

test('基准金额为零时金额只能为零', () => {
  const store = setup(1);
  // 票量 1 的基准为 0.001 分，舍入为 0：金额必须恰好为 0。
  store.registerInvoice('op-inv-zero', {
    invoiceId: 'I-ZERO',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1, amountCents: 0 }],
  });
  store.registerInvoice('op-inv-nonzero', {
    invoiceId: 'I-NONZERO',
    lines: [{ orderId: 'O1', lineId: 'L1', qty: 1, amountCents: 1 }],
  });
  const snap = store.getSnapshot();
  assert.equal(statusOf(snap, 'I-ZERO'), 'SETTLED');
  assert.equal(statusOf(snap, 'I-NONZERO'), 'PENDING');
  store.close();
});

test('18 位整数精确计算', () => {
  // qty*price 达 21 位（远超 double 的 2^53），基准金额仍为 18 位。
  const qty = 999_999_999_999n;
  const price = 999_999_999n;
  const expected = (qty * price + 500n) / 1000n; // 999999998999000000
  assert.equal(expected.toString().length, 18);

  const open = () => {
    const store = ReconciliationStore.open(freshDbPath());
    store.registerOrder('op-order', {
      orderId: 'O1',
      currency: 'CNY',
      lines: [{ lineId: 'L1', qty, priceCents: price }],
    });
    store.registerReceipt('op-rcpt', {
      receiptId: 'R1',
      lines: [{ orderId: 'O1', lineId: 'L1', qualified: qty, pending: 0, unqualified: 0 }],
    });
    return store;
  };

  // 恰好 2% 边界（50*|diff| == base）：可核销。
  const tolerance = expected / 50n;
  const storeOk = open();
  storeOk.registerInvoice('op-inv', {
    invoiceId: 'I-OK',
    lines: [{ orderId: 'O1', lineId: 'L1', qty, amountCents: expected - tolerance }],
  });
  const snapOk = storeOk.getSnapshot();
  assert.equal(statusOf(snapOk, 'I-OK'), 'SETTLED');
  assert.equal(lineOf(snapOk, 'L1').matchedQty, qty);
  assert.equal(lineOf(snapOk, 'L1').matchedAmountCents, expected - tolerance);
  assert.equal(lineOf(snapOk, 'L1').baselineCents, expected);
  storeOk.close();

  // 边界再少 1 分：整票待匹配。
  const storeBad = open();
  storeBad.registerInvoice('op-inv', {
    invoiceId: 'I-BAD',
    lines: [{ orderId: 'O1', lineId: 'L1', qty, amountCents: expected - tolerance - 1n }],
  });
  const snapBad = storeBad.getSnapshot();
  assert.equal(statusOf(snapBad, 'I-BAD'), 'PENDING');
  assert.equal(lineOf(snapBad, 'L1').matchedQty, 0n);
  storeBad.close();
});

test('单个数值超过 18 位被拒绝', () => {
  const store = ReconciliationStore.open(freshDbPath());
  store.registerOrder('op-order', {
    orderId: 'O1',
    currency: 'CNY',
    lines: [{ lineId: 'L1', qty: 1_000, priceCents: 1 }],
  });
  assert.throws(
    () =>
      store.registerReceipt('op-rcpt', {
        receiptId: 'R1',
        lines: [
          {
            orderId: 'O1',
            lineId: 'L1',
            qualified: '1000000000000000000',
            pending: 0,
            unqualified: 0,
          },
        ],
      }),
    RangeError,
  );
  store.close();
});
