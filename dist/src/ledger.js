import { randomUUID } from "node:crypto";
import { computeCumulativeShares } from "./allocation.js";
import { openDatabase } from "./db.js";
import { MAX_PAYMENT_AMOUNT_CENTS, PARTY_ROLES, SUPPORTED_CURRENCIES, } from "./types.js";
const ACCOUNT_RECEIVABLE = "clearing:receivable";
const ACCOUNT_REFUND = "clearing:refund";
function partyAccount(role) {
    return `party:${role}`;
}
function isPositiveInt(value) {
    return Number.isInteger(value) && value > 0;
}
function isNonNegativeInt(value) {
    return Number.isInteger(value) && value >= 0;
}
function toRefundRecord(row) {
    return {
        refundId: row.refund_id,
        merchantId: row.merchant_id,
        paymentId: row.payment_id,
        idempotencyKey: row.idempotency_key,
        amount: row.amount,
        status: row.status,
    };
}
export class Ledger {
    db;
    locks = new Map();
    constructor(dbPath) {
        this.db = openDatabase(dbPath);
    }
    async withLock(key, fn) {
        const prev = this.locks.get(key) ?? Promise.resolve();
        let release;
        const next = new Promise((resolve) => {
            release = resolve;
        });
        this.locks.set(key, prev.then(() => next));
        await prev;
        try {
            return fn();
        }
        finally {
            release();
        }
    }
    getPayment(paymentId) {
        return this.db
            .prepare("SELECT * FROM payments WHERE payment_id = ?")
            .get(paymentId);
    }
    getRefundByKey(merchantId, key) {
        return this.db
            .prepare("SELECT * FROM refunds WHERE merchant_id = ? AND idempotency_key = ?")
            .get(merchantId, key);
    }
    getRefund(refundId) {
        return this.db
            .prepare("SELECT * FROM refunds WHERE refund_id = ?")
            .get(refundId);
    }
    insertEntry(paymentId, currency, account, debit, credit, kind, refundId) {
        this.db
            .prepare(`INSERT INTO entries (payment_id, currency, account, debit, credit, kind, refund_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(paymentId, currency, account, debit, credit, kind, refundId);
    }
    async recordSettledPayment(input) {
        return this.withLock(`payment:${input.paymentId}`, () => {
            if (!SUPPORTED_CURRENCIES.includes(input.currency)) {
                throw new Error(`unsupported currency: ${input.currency}`);
            }
            if (!isPositiveInt(input.totalAmount) ||
                input.totalAmount > MAX_PAYMENT_AMOUNT_CENTS) {
                throw new Error(`invalid total amount: ${input.totalAmount}`);
            }
            const splits = input.splits;
            if (!PARTY_ROLES.every((role) => isNonNegativeInt(splits[role])) ||
                splits.merchant + splits.platform + splits.partner !== input.totalAmount) {
                throw new Error("splits must be non-negative integers summing to total");
            }
            if (this.getPayment(input.paymentId)) {
                throw new Error(`payment already recorded: ${input.paymentId}`);
            }
            this.db.exec("BEGIN IMMEDIATE");
            try {
                this.db
                    .prepare(`INSERT INTO payments
               (payment_id, merchant_id, currency, total_amount,
                split_merchant, split_platform, split_partner)
             VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(input.paymentId, input.merchantId, input.currency, input.totalAmount, splits.merchant, splits.platform, splits.partner);
                for (const role of PARTY_ROLES) {
                    if (splits[role] === 0)
                        continue;
                    this.insertEntry(input.paymentId, input.currency, partyAccount(role), splits[role], 0, "settlement", null);
                    this.insertEntry(input.paymentId, input.currency, ACCOUNT_RECEIVABLE, 0, splits[role], "settlement", null);
                }
                this.db.exec("COMMIT");
            }
            catch (err) {
                this.db.exec("ROLLBACK");
                throw err;
            }
        });
    }
    async requestRefund(merchantId, paymentId, idempotencyKey, amount) {
        return this.withLock(`payment:${paymentId}`, () => {
            if (!isPositiveInt(amount)) {
                return { ok: false, reason: "amount must be a positive integer" };
            }
            const existing = this.getRefundByKey(merchantId, idempotencyKey);
            if (existing) {
                if (existing.payment_id === paymentId && existing.amount === amount) {
                    return {
                        ok: true,
                        refund: toRefundRecord(existing),
                        duplicate: true,
                    };
                }
                return {
                    ok: false,
                    reason: "idempotency key already used with different payment or amount",
                };
            }
            const payment = this.getPayment(paymentId);
            if (!payment) {
                return { ok: false, reason: `unknown payment: ${paymentId}` };
            }
            if (payment.merchant_id !== merchantId) {
                return { ok: false, reason: "payment belongs to another merchant" };
            }
            const available = payment.total_amount - payment.refunded_amount - payment.held_amount;
            if (amount > available) {
                return { ok: false, reason: "insufficient refundable amount" };
            }
            const refundId = randomUUID();
            this.db.exec("BEGIN IMMEDIATE");
            try {
                this.db
                    .prepare(`INSERT INTO refunds (refund_id, merchant_id, payment_id, idempotency_key, amount, status)
             VALUES (?, ?, ?, ?, ?, 'processing')`)
                    .run(refundId, merchantId, paymentId, idempotencyKey, amount);
                this.db
                    .prepare("UPDATE payments SET held_amount = held_amount + ? WHERE payment_id = ?")
                    .run(amount, paymentId);
                this.db.exec("COMMIT");
            }
            catch (err) {
                this.db.exec("ROLLBACK");
                throw err;
            }
            return {
                ok: true,
                refund: {
                    refundId,
                    merchantId,
                    paymentId,
                    idempotencyKey,
                    amount,
                    status: "processing",
                },
                duplicate: false,
            };
        });
    }
    async receiveRefundResult(refundId, result) {
        const refund = this.getRefund(refundId);
        if (!refund) {
            throw new Error(`unknown refund: ${refundId}`);
        }
        return this.withLock(`payment:${refund.payment_id}`, () => {
            const current = this.getRefund(refundId);
            if (current.status !== "processing") {
                return;
            }
            if (result === "processing") {
                return;
            }
            if (result === "failed") {
                this.db.exec("BEGIN IMMEDIATE");
                try {
                    this.db
                        .prepare("UPDATE refunds SET status = 'failed' WHERE refund_id = ?")
                        .run(refundId);
                    this.db
                        .prepare("UPDATE payments SET held_amount = held_amount - ? WHERE payment_id = ?")
                        .run(current.amount, current.payment_id);
                    this.db.exec("COMMIT");
                }
                catch (err) {
                    this.db.exec("ROLLBACK");
                    throw err;
                }
                return;
            }
            const payment = this.getPayment(current.payment_id);
            const newRefunded = payment.refunded_amount + current.amount;
            const splits = {
                merchant: payment.split_merchant,
                platform: payment.split_platform,
                partner: payment.split_partner,
            };
            const newShares = computeCumulativeShares(newRefunded, payment.total_amount, splits);
            const oldShares = {
                merchant: payment.share_merchant,
                platform: payment.share_platform,
                partner: payment.share_partner,
            };
            this.db.exec("BEGIN IMMEDIATE");
            try {
                this.db
                    .prepare("UPDATE refunds SET status = 'succeeded' WHERE refund_id = ?")
                    .run(refundId);
                this.db
                    .prepare(`UPDATE payments
             SET refunded_amount = ?, held_amount = held_amount - ?,
                 share_merchant = ?, share_platform = ?, share_partner = ?
             WHERE payment_id = ?`)
                    .run(newRefunded, current.amount, newShares.merchant, newShares.platform, newShares.partner, current.payment_id);
                for (const role of PARTY_ROLES) {
                    const delta = newShares[role] - oldShares[role];
                    if (delta > 0) {
                        this.insertEntry(current.payment_id, payment.currency, ACCOUNT_REFUND, delta, 0, "refund", refundId);
                        this.insertEntry(current.payment_id, payment.currency, partyAccount(role), 0, delta, "refund", refundId);
                    }
                    else if (delta < 0) {
                        this.insertEntry(current.payment_id, payment.currency, partyAccount(role), -delta, 0, "refund_reversal", refundId);
                        this.insertEntry(current.payment_id, payment.currency, ACCOUNT_REFUND, 0, -delta, "refund_reversal", refundId);
                    }
                }
                this.db.exec("COMMIT");
            }
            catch (err) {
                this.db.exec("ROLLBACK");
                throw err;
            }
        });
    }
    async getPaymentView(paymentId) {
        return this.withLock(`payment:${paymentId}`, () => {
            const payment = this.getPayment(paymentId);
            if (!payment) {
                throw new Error(`unknown payment: ${paymentId}`);
            }
            const refundRows = this.db
                .prepare("SELECT * FROM refunds WHERE payment_id = ? ORDER BY rowid ASC")
                .all(paymentId);
            const entryRows = this.db
                .prepare("SELECT * FROM entries WHERE payment_id = ? ORDER BY entry_id ASC")
                .all(paymentId);
            const splits = {
                merchant: payment.split_merchant,
                platform: payment.split_platform,
                partner: payment.split_partner,
            };
            const shares = {
                merchant: payment.share_merchant,
                platform: payment.share_platform,
                partner: payment.share_partner,
            };
            return {
                paymentId: payment.payment_id,
                merchantId: payment.merchant_id,
                currency: payment.currency,
                totalAmount: payment.total_amount,
                refundedAmount: payment.refunded_amount,
                heldAmount: payment.held_amount,
                availableAmount: payment.total_amount - payment.refunded_amount - payment.held_amount,
                originalSplits: splits,
                cumulativeRefundedSplits: shares,
                netSplits: {
                    merchant: splits.merchant - shares.merchant,
                    platform: splits.platform - shares.platform,
                    partner: splits.partner - shares.partner,
                },
                refunds: refundRows.map(toRefundRecord),
                entries: entryRows.map((row) => ({
                    entryId: row.entry_id,
                    paymentId: row.payment_id,
                    currency: row.currency,
                    account: row.account,
                    debit: row.debit,
                    credit: row.credit,
                    kind: row.kind,
                    refundId: row.refund_id,
                    createdSeq: row.entry_id,
                })),
            };
        });
    }
    async close() {
        this.db.close();
    }
}
