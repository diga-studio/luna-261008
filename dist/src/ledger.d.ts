import { type PaymentView, type RefundResultKind, type RequestRefundOutcome, type SettledPaymentInput } from "./types.js";
export declare class Ledger {
    private readonly db;
    private readonly locks;
    constructor(dbPath: string);
    private withLock;
    private getPayment;
    private getRefundByKey;
    private getRefund;
    private insertEntry;
    recordSettledPayment(input: SettledPaymentInput): Promise<void>;
    requestRefund(merchantId: string, paymentId: string, idempotencyKey: string, amount: number): Promise<RequestRefundOutcome>;
    receiveRefundResult(refundId: string, result: RefundResultKind): Promise<void>;
    getPaymentView(paymentId: string): Promise<PaymentView>;
    close(): Promise<void>;
}
