import assert from "node:assert/strict";
import { test } from "node:test";
import { freshLedger } from "./helpers.js";
async function setupNineCentPayment(ledger) {
    await ledger.recordSettledPayment({
        merchantId: "m1",
        paymentId: "p1",
        currency: "USD",
        totalAmount: 9,
        splits: { merchant: 5, platform: 3, partner: 1 },
    });
}
test("records a settled payment with balanced settlement entries", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        const view = await t.ledger.getPaymentView("p1");
        assert.equal(view.totalAmount, 9);
        assert.equal(view.refundedAmount, 0);
        assert.equal(view.heldAmount, 0);
        assert.equal(view.availableAmount, 9);
        assert.deepEqual(view.netSplits, { merchant: 5, platform: 3, partner: 1 });
        const debits = view.entries.reduce((sum, e) => sum + e.debit, 0);
        const credits = view.entries.reduce((sum, e) => sum + e.credit, 0);
        assert.equal(debits, credits);
        assert.equal(debits, 9);
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("rejects invalid payments", async () => {
    const t = freshLedger();
    try {
        await assert.rejects(t.ledger.recordSettledPayment({
            merchantId: "m1",
            paymentId: "p1",
            currency: "JPY",
            totalAmount: 9,
            splits: { merchant: 5, platform: 3, partner: 1 },
        }), /unsupported currency/);
        await assert.rejects(t.ledger.recordSettledPayment({
            merchantId: "m1",
            paymentId: "p1",
            currency: "USD",
            totalAmount: 10,
            splits: { merchant: 5, platform: 3, partner: 1 },
        }), /splits/);
        await assert.rejects(t.ledger.recordSettledPayment({
            merchantId: "m1",
            paymentId: "p1",
            currency: "USD",
            totalAmount: 5_000_001,
            splits: { merchant: 5_000_001, platform: 0, partner: 0 },
        }), /invalid total/);
        await setupNineCentPayment(t.ledger);
        await assert.rejects(setupNineCentPayment(t.ledger), /already recorded/);
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("acceptance: 9-cent payment, refund 4 then 1, partner reversal of 1", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        const r1 = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        assert.equal(r1.ok, true);
        if (!r1.ok)
            return;
        await t.ledger.receiveRefundResult(r1.refund.refundId, "succeeded");
        let view = await t.ledger.getPaymentView("p1");
        assert.equal(view.refundedAmount, 4);
        assert.deepEqual(view.cumulativeRefundedSplits, {
            merchant: 2,
            platform: 1,
            partner: 1,
        });
        const r2 = await t.ledger.requestRefund("m1", "p1", "k2", 1);
        assert.equal(r2.ok, true);
        if (!r2.ok)
            return;
        await t.ledger.receiveRefundResult(r2.refund.refundId, "succeeded");
        view = await t.ledger.getPaymentView("p1");
        assert.equal(view.refundedAmount, 5);
        assert.deepEqual(view.cumulativeRefundedSplits, {
            merchant: 3,
            platform: 2,
            partner: 0,
        });
        assert.deepEqual(view.netSplits, { merchant: 2, platform: 1, partner: 1 });
        const reversal = view.entries.filter((e) => e.kind === "refund_reversal");
        assert.equal(reversal.length, 2);
        const partnerReversal = reversal.find((e) => e.account === "party:partner");
        assert.ok(partnerReversal);
        assert.equal(partnerReversal.debit, 1);
        assert.equal(partnerReversal.refundId, r2.refund.refundId);
        const debits = view.entries.reduce((sum, e) => sum + e.debit, 0);
        const credits = view.entries.reduce((sum, e) => sum + e.credit, 0);
        assert.equal(debits, credits);
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("idempotent refund requests return the original refund", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        const first = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        const again = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        assert.equal(first.ok && again.ok, true);
        if (!first.ok || !again.ok)
            return;
        assert.equal(again.duplicate, true);
        assert.equal(again.refund.refundId, first.refund.refundId);
        const view = await t.ledger.getPaymentView("p1");
        assert.equal(view.heldAmount, 4);
        assert.equal(view.refunds.length, 1);
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("idempotency key cannot be reused for another payment or amount", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        await t.ledger.recordSettledPayment({
            merchantId: "m1",
            paymentId: "p2",
            currency: "EUR",
            totalAmount: 100,
            splits: { merchant: 60, platform: 30, partner: 10 },
        });
        await t.ledger.requestRefund("m1", "p1", "k1", 4);
        const otherAmount = await t.ledger.requestRefund("m1", "p1", "k1", 3);
        assert.equal(otherAmount.ok, false);
        const otherPayment = await t.ledger.requestRefund("m1", "p2", "k1", 4);
        assert.equal(otherPayment.ok, false);
        const view = await t.ledger.getPaymentView("p1");
        assert.equal(view.heldAmount, 4);
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("failed refund releases its hold and retry with same key returns failure", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        const r = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        assert.equal(r.ok, true);
        if (!r.ok)
            return;
        await t.ledger.receiveRefundResult(r.refund.refundId, "failed");
        let view = await t.ledger.getPaymentView("p1");
        assert.equal(view.heldAmount, 0);
        assert.equal(view.availableAmount, 9);
        const retry = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        assert.equal(retry.ok, true);
        if (!retry.ok)
            return;
        assert.equal(retry.duplicate, true);
        assert.equal(retry.refund.status, "failed");
        assert.equal(retry.refund.refundId, r.refund.refundId);
        view = await t.ledger.getPaymentView("p1");
        assert.equal(view.heldAmount, 0);
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("processing and duplicate results do not change state; terminal sticks", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        const r = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        assert.equal(r.ok, true);
        if (!r.ok)
            return;
        await t.ledger.receiveRefundResult(r.refund.refundId, "processing");
        await t.ledger.receiveRefundResult(r.refund.refundId, "processing");
        let view = await t.ledger.getPaymentView("p1");
        assert.equal(view.heldAmount, 4);
        assert.equal(view.refundedAmount, 0);
        await t.ledger.receiveRefundResult(r.refund.refundId, "succeeded");
        await t.ledger.receiveRefundResult(r.refund.refundId, "succeeded");
        view = await t.ledger.getPaymentView("p1");
        assert.equal(view.refundedAmount, 4);
        const refundEntries = view.entries.filter((e) => e.kind === "refund");
        assert.equal(refundEntries.reduce((sum, e) => sum + e.debit, 0), 4);
        await t.ledger.receiveRefundResult(r.refund.refundId, "processing");
        view = await t.ledger.getPaymentView("p1");
        assert.equal(view.refunds[0].status, "succeeded");
        assert.equal(view.refundedAmount, 4);
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("out-of-order receipts: later refund succeeds before earlier one", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        const r1 = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        const r2 = await t.ledger.requestRefund("m1", "p1", "k2", 1);
        assert.equal(r1.ok && r2.ok, true);
        if (!r1.ok || !r2.ok)
            return;
        await t.ledger.receiveRefundResult(r2.refund.refundId, "succeeded");
        let view = await t.ledger.getPaymentView("p1");
        assert.equal(view.refundedAmount, 1);
        assert.equal(view.heldAmount, 4);
        await t.ledger.receiveRefundResult(r1.refund.refundId, "succeeded");
        view = await t.ledger.getPaymentView("p1");
        assert.equal(view.refundedAmount, 5);
        assert.deepEqual(view.cumulativeRefundedSplits, {
            merchant: 3,
            platform: 2,
            partner: 0,
        });
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("same total refunded via different splits and orders yields identical net splits", async () => {
    const t = freshLedger();
    try {
        const scenarios = [
            { payment: "pa", amounts: [4, 1] },
            { payment: "pb", amounts: [1, 4] },
            { payment: "pc", amounts: [2, 2, 1] },
            { payment: "pd", amounts: [1, 1, 1, 1, 1] },
            { payment: "pe", amounts: [5] },
        ];
        for (const s of scenarios) {
            await t.ledger.recordSettledPayment({
                merchantId: "m1",
                paymentId: s.payment,
                currency: "USD",
                totalAmount: 9,
                splits: { merchant: 5, platform: 3, partner: 1 },
            });
        }
        const refundsByPayment = new Map();
        for (const s of scenarios) {
            const ids = [];
            for (let i = 0; i < s.amounts.length; i += 1) {
                const r = await t.ledger.requestRefund("m1", s.payment, `${s.payment}-k${i}`, s.amounts[i]);
                assert.equal(r.ok, true);
                if (r.ok)
                    ids.push(r.refund.refundId);
            }
            refundsByPayment.set(s.payment, ids);
        }
        const reverse = [...scenarios].reverse();
        for (const s of reverse) {
            for (const id of refundsByPayment.get(s.payment)) {
                await t.ledger.receiveRefundResult(id, "succeeded");
            }
        }
        for (const s of scenarios) {
            const view = await t.ledger.getPaymentView(s.payment);
            assert.deepEqual(view.netSplits, { merchant: 2, platform: 1, partner: 1 }, s.payment);
            assert.deepEqual(view.cumulativeRefundedSplits, {
                merchant: 3,
                platform: 2,
                partner: 0,
            });
            assert.equal(view.refundedAmount, 5);
        }
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
test("refund clearing account balance equals cumulative succeeded refunds", async () => {
    const t = freshLedger();
    try {
        await setupNineCentPayment(t.ledger);
        const r1 = await t.ledger.requestRefund("m1", "p1", "k1", 4);
        const r2 = await t.ledger.requestRefund("m1", "p1", "k2", 1);
        assert.equal(r1.ok && r2.ok, true);
        if (!r1.ok || !r2.ok)
            return;
        await t.ledger.receiveRefundResult(r1.refund.refundId, "succeeded");
        await t.ledger.receiveRefundResult(r2.refund.refundId, "succeeded");
        const view = await t.ledger.getPaymentView("p1");
        const clearing = view.entries
            .filter((e) => e.account === "clearing:refund")
            .reduce((sum, e) => sum + e.debit - e.credit, 0);
        assert.equal(clearing, view.refundedAmount);
        for (const [role, account] of [
            ["merchant", "party:merchant"],
            ["platform", "party:platform"],
            ["partner", "party:partner"],
        ]) {
            const balance = view.entries
                .filter((e) => e.account === account)
                .reduce((sum, e) => sum + e.debit - e.credit, 0);
            assert.equal(balance, view.netSplits[role]);
        }
    }
    finally {
        await t.ledger.close();
        t.cleanup();
    }
});
