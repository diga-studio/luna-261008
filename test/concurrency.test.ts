import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Ledger } from '../src/index.ts';
import type { PaymentLedgerView } from '../src/index.ts';

interface WorkerOutcome {
  accepted: boolean;
  error?: string;
}

function runWorker(
  dbPath: string,
  key: string,
  amount: number,
  result: 'succeeded' | 'failed' | null,
): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/refund-worker.ts', import.meta.url), {
      workerData: { dbPath, merchantId: 'm1', paymentId: 'p1', key, amount, result },
    });
    worker.on('message', (value) => resolve(value as WorkerOutcome));
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });
}

function assertBooksBalance(view: PaymentLedgerView, original: { merchant: number; platform: number; partner: number }): void {
  assert.ok(view.refundedTotal + view.reservedTotal <= view.totalAmount);
  assert.equal(view.refundClearingReceived, view.refundedTotal);
  assert.equal(
    view.cumulativeDue.merchant + view.cumulativeDue.platform + view.cumulativeDue.partner,
    view.refundedTotal,
  );
  assert.equal(view.netAmounts.merchant, original.merchant - view.cumulativeDue.merchant);
  assert.equal(view.netAmounts.platform, original.platform - view.cumulativeDue.platform);
  assert.equal(view.netAmounts.partner, original.partner - view.cumulativeDue.partner);

  const balances = new Map<string, number>();
  for (const entry of view.entries) {
    assert.equal(entry.currency, view.currency);
    balances.set(entry.debitAccount, (balances.get(entry.debitAccount) ?? 0) - entry.amount);
    balances.set(entry.creditAccount, (balances.get(entry.creditAccount) ?? 0) + entry.amount);
  }
  assert.equal(balances.get(`clearing:refund:${view.currency}`), view.refundedTotal);
  assert.equal(balances.get(`party:merchant:m1:${view.currency}`), view.netAmounts.merchant);
  assert.equal(balances.get(`party:platform:${view.currency}`), view.netAmounts.platform);
  assert.equal(balances.get(`party:partner:${view.currency}`), view.netAmounts.partner);
}

test('64 concurrent successful refunds: at most 50 win capacity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-ledger-'));
  const dbPath = join(dir, 'ledger.db');
  const original = { merchant: 2_500_000, platform: 1_500_000, partner: 1_000_000 };
  try {
    const ledger = new Ledger(dbPath);
    ledger.recordSettledPayment({
      merchantId: 'm1',
      paymentId: 'p1',
      currency: 'USD',
      totalAmount: 5_000_000,
      original,
    });
    ledger.close();

    // 64 x 100,000 = 6,400,000 > 5,000,000 and successes never release capacity
    const jobs: Array<Promise<WorkerOutcome>> = [];
    for (let i = 0; i < 64; i += 1) {
      jobs.push(runWorker(dbPath, `r${i}`, 100_000, 'succeeded'));
    }
    const outcomes = await Promise.all(jobs);
    const accepted = outcomes.filter((o) => o.accepted).length;
    assert.ok(accepted <= 50, `accepted ${accepted} refunds beyond capacity`);
    assert.ok(accepted >= 40, `too many refunds failed spuriously: ${64 - accepted}`);
    for (const o of outcomes.filter((x) => !x.accepted)) {
      assert.match(o.error ?? '', /exceeds remaining capacity/);
    }

    const check = new Ledger(dbPath);
    const view = check.getLedger('m1', 'p1');
    assert.equal(view.refundedTotal, accepted * 100_000);
    assert.equal(view.reservedTotal, 0);
    assertBooksBalance(view, original);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('64 concurrent mixed results: failures release capacity, books still balance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-ledger-'));
  const dbPath = join(dir, 'ledger.db');
  const original = { merchant: 2_500_000, platform: 1_500_000, partner: 1_000_000 };
  try {
    const ledger = new Ledger(dbPath);
    ledger.recordSettledPayment({
      merchantId: 'm1',
      paymentId: 'p1',
      currency: 'USD',
      totalAmount: 5_000_000,
      original,
    });
    ledger.close();

    const jobs: Array<Promise<WorkerOutcome>> = [];
    for (let i = 0; i < 64; i += 1) {
      const result = i % 3 === 2 ? 'failed' : 'succeeded';
      jobs.push(runWorker(dbPath, `r${i}`, 100_000, result));
    }
    await Promise.all(jobs);

    const check = new Ledger(dbPath);
    const view = check.getLedger('m1', 'p1');
    const succeeded = view.refunds.filter((r) => r.status === 'succeeded').length;
    const failed = view.refunds.filter((r) => r.status === 'failed').length;
    assert.equal(view.refundedTotal, succeeded * 100_000);
    assert.equal(view.reservedTotal, 0);
    assert.ok(failed >= 1);
    assertBooksBalance(view, original);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
