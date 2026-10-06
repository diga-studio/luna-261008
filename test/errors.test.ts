import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/index.ts';

test('operations on unknown payments and refunds fail cleanly', () => {
  const ledger = new Ledger(':memory:');
  assert.throws(
    () => ledger.requestRefund({ merchantId: 'm1', paymentId: 'nope', idempotencyKey: 'r1', amount: 1 }),
    /payment not found/,
  );
  assert.throws(() => ledger.getLedger('m1', 'nope'), /payment not found/);

  ledger.recordSettledPayment({
    merchantId: 'm1',
    paymentId: 'p1',
    currency: 'USD',
    totalAmount: 9,
    original: { merchant: 5, platform: 3, partner: 1 },
  });
  assert.throws(
    () =>
      ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'ghost', kind: 'succeeded' }),
    /refund not found/,
  );
  assert.throws(() => ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 0 }), /positive integer/);
  assert.throws(() => ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 1.5 }), /positive integer/);
  ledger.close();
});

test('result delivered for a key owned by another payment is not found', () => {
  const ledger = new Ledger(':memory:');
  for (const paymentId of ['p1', 'p2']) {
    ledger.recordSettledPayment({
      merchantId: 'm1',
      paymentId,
      currency: 'USD',
      totalAmount: 9,
      original: { merchant: 5, platform: 3, partner: 1 },
    });
  }
  ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
  assert.throws(
    () => ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p2', idempotencyKey: 'r1', kind: 'succeeded' }),
    /refund not found/,
  );
  ledger.close();
});
