import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/index.ts';
import type { PaymentLedgerView } from '../src/index.ts';

function newLedger(): Ledger {
  return new Ledger(':memory:');
}

function recordNineCentPayment(ledger: Ledger): void {
  ledger.recordSettledPayment({
    merchantId: 'm1',
    paymentId: 'p1',
    currency: 'USD',
    totalAmount: 9,
    original: { merchant: 5, platform: 3, partner: 1 },
  });
}

test('record settled payment validates inputs', () => {
  const ledger = newLedger();
  assert.throws(
    () =>
      ledger.recordSettledPayment({
        merchantId: 'm1',
        paymentId: 'p1',
        currency: 'USD',
        totalAmount: 10,
        original: { merchant: 5, platform: 3, partner: 1 },
      }),
    /do not sum/,
  );
  assert.throws(
    () =>
      ledger.recordSettledPayment({
        merchantId: 'm1',
        paymentId: 'p1',
        currency: 'JPY' as never,
        totalAmount: 9,
        original: { merchant: 5, platform: 3, partner: 1 },
      }),
    /unsupported currency/,
  );
  assert.throws(
    () =>
      ledger.recordSettledPayment({
        merchantId: 'm1',
        paymentId: 'p1',
        currency: 'USD',
        totalAmount: 5_000_001,
        original: { merchant: 5_000_001, platform: 0, partner: 0 },
      }),
    /exceeds limit/,
  );
  ledger.close();
});

test('settled payment writes balanced settlement entries', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  const view = ledger.getLedger('m1', 'p1');
  assert.equal(view.entries.length, 3);
  for (const entry of view.entries) {
    assert.equal(entry.debitAccount, 'clearing:settlement:USD');
    assert.equal(entry.memo, 'settlement');
  }
  const settled = view.entries.reduce((sum, e) => sum + e.amount, 0);
  assert.equal(settled, 9);
  assert.deepEqual(view.netAmounts, { merchant: 5, platform: 3, partner: 1 });
  assert.equal(view.refundedTotal, 0);
  assert.equal(view.reservedTotal, 0);
  ledger.close();
});

test('duplicate payment recording is rejected', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  assert.throws(() => recordNineCentPayment(ledger), /already recorded/);
  ledger.close();
});

test('partial refunds reserve capacity without blocking others', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', amount: 3 });
  // 4 + 3 = 7 reserved, 2 remaining
  assert.throws(
    () => ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r3', amount: 3 }),
    /exceeds remaining capacity/,
  );
  const ok = ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r4', amount: 2 });
  assert.equal(ok.status, 'processing');
  const view = ledger.getLedger('m1', 'p1');
  assert.equal(view.reservedTotal, 9);
  assert.equal(view.refundedTotal, 0);
  ledger.close();
});

test('over-capacity rejection occupies nothing and writes no entries', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 9 });
  assert.throws(
    () => ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', amount: 1 }),
    /exceeds remaining capacity/,
  );
  const view = ledger.getLedger('m1', 'p1');
  assert.equal(view.reservedTotal, 9);
  assert.equal(view.refunds.length, 1);
  assert.equal(view.entries.filter((e) => e.memo !== 'settlement').length, 0);
  ledger.close();
});

test('idempotent retry returns the same refund without reserving twice', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  const first = ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  const second = ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  assert.deepEqual(second, first);
  const view = ledger.getLedger('m1', 'p1');
  assert.equal(view.reservedTotal, 4);
  assert.equal(view.refunds.length, 1);
  ledger.close();
});

test('idempotency key cannot be reused for another payment or amount', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.recordSettledPayment({
    merchantId: 'm1',
    paymentId: 'p2',
    currency: 'USD',
    totalAmount: 9,
    original: { merchant: 5, platform: 3, partner: 1 },
  });
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  assert.throws(
    () => ledger.requestRefund({ merchantId: 'm1', paymentId: 'p2', idempotencyKey: 'r1', amount: 4 }),
    /idempotency key reused/,
  );
  assert.throws(
    () => ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 5 }),
    /idempotency key reused/,
  );
  ledger.close();
});

test('failure releases reservation and retrying the key returns the failure', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 9 });
  const failed = ledger.receiveRefundResult({
    merchantId: 'm1',
    paymentId: 'p1',
    idempotencyKey: 'r1',
    kind: 'failed',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(ledger.getLedger('m1', 'p1').reservedTotal, 0);
  // capacity is free again for a new key
  const again = ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', amount: 9 });
  assert.equal(again.status, 'processing');
  // retrying the failed key still returns the original failed refund
  const retry = ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 9 });
  assert.equal(retry.status, 'failed');
  ledger.close();
});

test('duplicate and out-of-order results are no-ops', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', kind: 'processing' });
  ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', kind: 'succeeded' });
  // duplicate success must not count twice
  const dup = ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', kind: 'succeeded' });
  assert.equal(dup.status, 'succeeded');
  // processing after terminal must not roll back
  const late = ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', kind: 'processing' });
  assert.equal(late.status, 'succeeded');
  const view = ledger.getLedger('m1', 'p1');
  assert.equal(view.refundedTotal, 4);
  assert.equal(view.reservedTotal, 0);
  assert.equal(view.refundClearingReceived, 4);
  ledger.close();
});

test('acceptance: 9-cent payment refunded 4 then 1 yields 3/2/0 with partner reversal', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', kind: 'succeeded' });
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', amount: 1 });
  ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', kind: 'succeeded' });

  const view = ledger.getLedger('m1', 'p1');
  assert.deepEqual(view.cumulativeDue, { merchant: 3, platform: 2, partner: 0 });
  assert.deepEqual(view.netAmounts, { merchant: 2, platform: 1, partner: 1 });
  assert.equal(view.refundedTotal, 5);
  assert.equal(view.refundClearingReceived, 5);

  const shareEntries = view.entries.filter((e) => e.memo === 'refund_share');
  // second refund must include a 1-cent reversal back to the partner
  const partnerReversal = shareEntries.find(
    (e) => e.refundKey === 'r2' && e.debitAccount === 'party:partner:USD',
  );
  assert.ok(partnerReversal, 'expected partner adjustment entry for r2');
  assert.equal(partnerReversal.amount, -1);
  assert.equal(partnerReversal.creditAccount, 'clearing:refund:USD');
  ledger.close();
});

test('same total refunded via different splits and receipt orders ends identical', () => {
  const run = (steps: Array<{ key: string; amount: number }>, receiptOrder: string[]): PaymentLedgerView => {
    const ledger = newLedger();
    recordNineCentPayment(ledger);
    for (const step of steps) {
      ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: step.key, amount: step.amount });
    }
    for (const key of receiptOrder) {
      ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: key, kind: 'succeeded' });
    }
    const view = ledger.getLedger('m1', 'p1');
    ledger.close();
    return view;
  };

  const a = run(
    [
      { key: 'r1', amount: 4 },
      { key: 'r2', amount: 1 },
    ],
    ['r1', 'r2'],
  );
  const b = run(
    [
      { key: 'r1', amount: 2 },
      { key: 'r2', amount: 2 },
      { key: 'r3', amount: 1 },
    ],
    ['r3', 'r1', 'r2'],
  );
  const c = run([{ key: 'r1', amount: 5 }], ['r1']);

  for (const view of [b, c]) {
    assert.deepEqual(view.netAmounts, a.netAmounts);
    assert.deepEqual(view.cumulativeDue, a.cumulativeDue);
    assert.equal(view.refundedTotal, a.refundedTotal);
    assert.equal(view.refundClearingReceived, a.refundClearingReceived);
  }
});

test('currencies are accounted independently', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.recordSettledPayment({
    merchantId: 'm1',
    paymentId: 'p2',
    currency: 'EUR',
    totalAmount: 100,
    original: { merchant: 60, platform: 30, partner: 10 },
  });
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p2', idempotencyKey: 'r1', amount: 50 });
  ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p2', idempotencyKey: 'r1', kind: 'succeeded' });

  const usd = ledger.getLedger('m1', 'p1');
  const eur = ledger.getLedger('m1', 'p2');
  assert.equal(usd.refundedTotal, 0);
  assert.equal(eur.refundedTotal, 50);
  assert.ok(eur.entries.every((e) => e.currency === 'EUR'));
  assert.ok(usd.entries.every((e) => e.currency === 'USD'));
  ledger.close();
});

test('per-currency books stay balanced when recomputed from entries', () => {
  const ledger = newLedger();
  recordNineCentPayment(ledger);
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', kind: 'succeeded' });
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', amount: 1 });
  ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', kind: 'succeeded' });

  const view = ledger.getLedger('m1', 'p1');
  const balances = new Map<string, number>();
  for (const entry of view.entries) {
    balances.set(entry.debitAccount, (balances.get(entry.debitAccount) ?? 0) - entry.amount);
    balances.set(entry.creditAccount, (balances.get(entry.creditAccount) ?? 0) + entry.amount);
  }
  // every account balance derived from flows matches the reported state
  assert.equal(balances.get('party:merchant:m1:USD'), view.netAmounts.merchant);
  assert.equal(balances.get('party:platform:USD'), view.netAmounts.platform);
  assert.equal(balances.get('party:partner:USD'), view.netAmounts.partner);
  assert.equal(balances.get('clearing:refund:USD'), view.refundClearingReceived);
  assert.equal(balances.get('clearing:settlement:USD'), -view.totalAmount);
  ledger.close();
});
