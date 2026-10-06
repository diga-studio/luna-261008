import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/index.ts';

function tempDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'refund-ledger-'));
  return { dir, file: join(dir, 'ledger.db') };
}

test('state survives close and reopen', () => {
  const { dir, file } = tempDbPath();
  try {
    const ledger = new Ledger(file);
    ledger.recordSettledPayment({
      merchantId: 'm1',
      paymentId: 'p1',
      currency: 'GBP',
      totalAmount: 9,
      original: { merchant: 5, platform: 3, partner: 1 },
    });
    ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
    ledger.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', kind: 'succeeded' });
    ledger.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', amount: 2 });
    const before = ledger.getLedger('m1', 'p1');
    ledger.close();

    const reopened = new Ledger(file);
    const after = reopened.getLedger('m1', 'p1');
    assert.deepEqual(after, before);
    assert.equal(after.refundedTotal, 4);
    assert.equal(after.reservedTotal, 2);

    // idempotent replay returns the original refund, no extra reservation
    const replay = reopened.requestRefund({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r1', amount: 4 });
    assert.equal(replay.status, 'succeeded');
    assert.equal(reopened.getLedger('m1', 'p1').reservedTotal, 2);

    // failed result replayed after reopen keeps its state
    reopened.receiveRefundResult({ merchantId: 'm1', paymentId: 'p1', idempotencyKey: 'r2', kind: 'failed' });
    reopened.close();
    const again = new Ledger(file);
    const view = again.getLedger('m1', 'p1');
    assert.equal(view.reservedTotal, 0);
    assert.equal(view.refunds.find((r) => r.idempotencyKey === 'r2')?.status, 'failed');
    assert.equal(view.entries.length, before.entries.length);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
