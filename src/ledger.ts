import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import { computeCumulativeShares } from './allocation.ts';
import {
  DuplicatePaymentError,
  IdempotencyConflictError,
  PaymentNotFoundError,
  RefundNotFoundError,
  ValidationError,
} from './errors.ts';
import type {
  Currency,
  Party,
  PartyAmounts,
  PaymentLedgerView,
  RefundRequest,
  RefundResult,
  RefundStatus,
  RefundView,
  SettledPaymentInput,
} from './types.ts';

const MAX_PAYMENT_AMOUNT = 5_000_000;
const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP'];
const PARTY_ORDER: readonly Party[] = ['merchant', 'platform', 'partner'];

interface PaymentRow {
  merchant_id: string;
  payment_id: string;
  currency: string;
  total_amount: number;
  orig_merchant: number;
  orig_platform: number;
  orig_partner: number;
  refunded_total: number;
  reserved_total: number;
  share_merchant: number;
  share_platform: number;
  share_partner: number;
  clearing_received: number;
}

interface RefundRow {
  merchant_id: string;
  payment_id: string;
  idempotency_key: string;
  amount: number;
  status: string;
  created_seq: number;
}

function settlementAccount(currency: string): string {
  return `clearing:settlement:${currency}`;
}

function refundClearingAccount(currency: string): string {
  return `clearing:refund:${currency}`;
}

function partyAccount(party: Party, merchantId: string, currency: string): string {
  if (party === 'merchant') return `party:merchant:${merchantId}:${currency}`;
  return `party:${party}:${currency}`;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer, got ${value}`);
  }
}

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  recordSettledPayment(input: SettledPaymentInput): void {
    if (!CURRENCIES.includes(input.currency)) {
      throw new ValidationError(`unsupported currency: ${input.currency}`);
    }
    assertPositiveInteger(input.totalAmount, 'totalAmount');
    if (input.totalAmount > MAX_PAYMENT_AMOUNT) {
      throw new ValidationError(`totalAmount exceeds limit: ${input.totalAmount}`);
    }
    assertNonNegativeInteger(input.original.merchant, 'original.merchant');
    assertNonNegativeInteger(input.original.platform, 'original.platform');
    assertNonNegativeInteger(input.original.partner, 'original.partner');
    const sum = input.original.merchant + input.original.platform + input.original.partner;
    if (sum !== input.totalAmount) {
      throw new ValidationError(`original amounts ${sum} do not sum to totalAmount ${input.totalAmount}`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT payment_id FROM payments WHERE merchant_id = ? AND payment_id = ?')
        .get(input.merchantId, input.paymentId);
      if (existing) throw new DuplicatePaymentError(input.paymentId);

      this.db
        .prepare(
          `INSERT INTO payments (merchant_id, payment_id, currency, total_amount,
             orig_merchant, orig_platform, orig_partner)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.merchantId,
          input.paymentId,
          input.currency,
          input.totalAmount,
          input.original.merchant,
          input.original.platform,
          input.original.partner,
        );

      const insertEntry = this.db.prepare(
        `INSERT INTO entries (merchant_id, payment_id, currency, debit_account, credit_account, amount, refund_key, memo)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      );
      for (const party of PARTY_ORDER) {
        const amount = input.original[party];
        if (amount === 0) continue;
        insertEntry.run(
          input.merchantId,
          input.paymentId,
          input.currency,
          settlementAccount(input.currency),
          partyAccount(party, input.merchantId, input.currency),
          amount,
          'settlement',
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  requestRefund(request: RefundRequest): RefundView {
    assertPositiveInteger(request.amount, 'amount');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const payment = this.getPaymentRow(request.merchantId, request.paymentId);

      const existing = this.getRefundRow(request.merchantId, request.idempotencyKey);
      if (existing) {
        if (existing.payment_id !== request.paymentId || existing.amount !== request.amount) {
          throw new IdempotencyConflictError(request.idempotencyKey);
        }
        const view = refundView(existing);
        this.db.exec('COMMIT');
        return view;
      }

      const remaining = payment.total_amount - payment.refunded_total - payment.reserved_total;
      if (request.amount > remaining) {
        throw new ValidationError(
          `refund amount ${request.amount} exceeds remaining capacity ${remaining}`,
        );
      }

      const result = this.db
        .prepare(
          `INSERT INTO refunds (merchant_id, payment_id, idempotency_key, amount, status, created_seq)
           VALUES (?, ?, ?, ?, 'processing', 0)`,
        )
        .run(request.merchantId, request.paymentId, request.idempotencyKey, request.amount);
      this.db
        .prepare('UPDATE refunds SET created_seq = ? WHERE merchant_id = ? AND idempotency_key = ?')
        .run(Number(result.lastInsertRowid), request.merchantId, request.idempotencyKey);
      this.db
        .prepare('UPDATE payments SET reserved_total = reserved_total + ? WHERE merchant_id = ? AND payment_id = ?')
        .run(request.amount, request.merchantId, request.paymentId);

      this.db.exec('COMMIT');
      return { idempotencyKey: request.idempotencyKey, amount: request.amount, status: 'processing' };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  receiveRefundResult(result: RefundResult): RefundView {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const refund = this.getRefundRow(result.merchantId, result.idempotencyKey);
      if (!refund || refund.payment_id !== result.paymentId) {
        throw new RefundNotFoundError(result.idempotencyKey);
      }

      if (refund.status === 'processing' && result.kind !== 'processing') {
        if (result.kind === 'failed') {
          this.applyFailure(refund);
        } else {
          this.applySuccess(refund);
        }
      }
      // duplicate results, out-of-order 'processing' after a terminal state,
      // and contradictory terminal results are all no-ops.

      const current = this.getRefundRow(result.merchantId, result.idempotencyKey);
      const view = refundView(current as RefundRow);
      this.db.exec('COMMIT');
      return view;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getLedger(merchantId: string, paymentId: string): PaymentLedgerView {
    this.db.exec('BEGIN');
    try {
      const payment = this.getPaymentRow(merchantId, paymentId);
      const refunds = this.db
        .prepare(
          'SELECT * FROM refunds WHERE merchant_id = ? AND payment_id = ? ORDER BY created_seq',
        )
        .all(merchantId, paymentId) as unknown as RefundRow[];
      const entryRows = this.db
        .prepare(
          'SELECT * FROM entries WHERE merchant_id = ? AND payment_id = ? ORDER BY seq',
        )
        .all(merchantId, paymentId) as unknown as Array<Record<string, unknown>>;

      const original: PartyAmounts = {
        merchant: payment.orig_merchant,
        platform: payment.orig_platform,
        partner: payment.orig_partner,
      };
      const cumulativeDue: PartyAmounts = {
        merchant: payment.share_merchant,
        platform: payment.share_platform,
        partner: payment.share_partner,
      };
      const netAmounts: PartyAmounts = {
        merchant: original.merchant - cumulativeDue.merchant,
        platform: original.platform - cumulativeDue.platform,
        partner: original.partner - cumulativeDue.partner,
      };

      const view: PaymentLedgerView = {
        merchantId,
        paymentId,
        currency: payment.currency as Currency,
        totalAmount: payment.total_amount,
        original,
        refundedTotal: payment.refunded_total,
        reservedTotal: payment.reserved_total,
        cumulativeDue,
        netAmounts,
        refundClearingReceived: payment.clearing_received,
        refunds: refunds.map(refundView),
        entries: entryRows.map((row) => ({
          seq: row.seq as number,
          currency: row.currency as Currency,
          debitAccount: row.debit_account as string,
          creditAccount: row.credit_account as string,
          amount: row.amount as number,
          refundKey: (row.refund_key as string | null) ?? null,
          memo: row.memo as string,
        })),
      };
      this.db.exec('COMMIT');
      return view;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private getPaymentRow(merchantId: string, paymentId: string): PaymentRow {
    const row = this.db
      .prepare('SELECT * FROM payments WHERE merchant_id = ? AND payment_id = ?')
      .get(merchantId, paymentId) as unknown as PaymentRow | undefined;
    if (!row) throw new PaymentNotFoundError(paymentId);
    return row;
  }

  private getRefundRow(merchantId: string, key: string): RefundRow | undefined {
    return this.db
      .prepare('SELECT * FROM refunds WHERE merchant_id = ? AND idempotency_key = ?')
      .get(merchantId, key) as unknown as RefundRow | undefined;
  }

  private applyFailure(refund: RefundRow): void {
    this.db
      .prepare(`UPDATE refunds SET status = 'failed' WHERE merchant_id = ? AND idempotency_key = ?`)
      .run(refund.merchant_id, refund.idempotency_key);
    this.db
      .prepare('UPDATE payments SET reserved_total = reserved_total - ? WHERE merchant_id = ? AND payment_id = ?')
      .run(refund.amount, refund.merchant_id, refund.payment_id);
  }

  private applySuccess(refund: RefundRow): void {
    const payment = this.getPaymentRow(refund.merchant_id, refund.payment_id);
    const original: PartyAmounts = {
      merchant: payment.orig_merchant,
      platform: payment.orig_platform,
      partner: payment.orig_partner,
    };
    const previous: PartyAmounts = {
      merchant: payment.share_merchant,
      platform: payment.share_platform,
      partner: payment.share_partner,
    };
    const newRefundedTotal = payment.refunded_total + refund.amount;
    const next = computeCumulativeShares(newRefundedTotal, payment.total_amount, original);

    this.db
      .prepare(`UPDATE refunds SET status = 'succeeded' WHERE merchant_id = ? AND idempotency_key = ?`)
      .run(refund.merchant_id, refund.idempotency_key);
    this.db
      .prepare(
        `UPDATE payments SET
           refunded_total = ?,
           reserved_total = reserved_total - ?,
           share_merchant = ?,
           share_platform = ?,
           share_partner = ?,
           clearing_received = ?
         WHERE merchant_id = ? AND payment_id = ?`,
      )
      .run(
        newRefundedTotal,
        refund.amount,
        next.merchant,
        next.platform,
        next.partner,
        newRefundedTotal,
        refund.merchant_id,
        refund.payment_id,
      );

    const insertEntry = this.db.prepare(
      `INSERT INTO entries (merchant_id, payment_id, currency, debit_account, credit_account, amount, refund_key, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'refund_share')`,
    );
    for (const party of PARTY_ORDER) {
      const delta = next[party] - previous[party];
      if (delta === 0) continue;
      insertEntry.run(
        refund.merchant_id,
        refund.payment_id,
        payment.currency,
        partyAccount(party, refund.merchant_id, payment.currency),
        refundClearingAccount(payment.currency),
        delta,
        refund.idempotency_key,
      );
    }
  }
}

function refundView(row: RefundRow): RefundView {
  return {
    idempotencyKey: row.idempotency_key,
    amount: row.amount,
    status: row.status as RefundStatus,
  };
}
