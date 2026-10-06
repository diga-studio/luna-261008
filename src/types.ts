export type Currency = "USD" | "EUR" | "GBP";

export const SUPPORTED_CURRENCIES: readonly Currency[] = ["USD", "EUR", "GBP"];

export const MAX_PAYMENT_AMOUNT_CENTS = 5_000_000;

export type PartyRole = "merchant" | "platform" | "partner";

export const PARTY_ROLES: readonly PartyRole[] = ["merchant", "platform", "partner"];

export interface PartyAmounts {
  merchant: number;
  platform: number;
  partner: number;
}

export interface SettledPaymentInput {
  merchantId: string;
  paymentId: string;
  currency: Currency;
  totalAmount: number;
  splits: PartyAmounts;
}

export type RefundStatus = "processing" | "succeeded" | "failed";

export type RefundResultKind = "processing" | "succeeded" | "failed";

export interface RefundRecord {
  refundId: string;
  merchantId: string;
  paymentId: string;
  idempotencyKey: string;
  amount: number;
  status: RefundStatus;
}

export type RequestRefundOutcome =
  | { ok: true; refund: RefundRecord; duplicate: boolean }
  | { ok: false; reason: string };

export interface LedgerEntry {
  entryId: number;
  paymentId: string;
  currency: Currency;
  account: string;
  debit: number;
  credit: number;
  kind: "settlement" | "refund" | "refund_reversal";
  refundId: string | null;
  createdSeq: number;
}

export interface PaymentView {
  paymentId: string;
  merchantId: string;
  currency: Currency;
  totalAmount: number;
  refundedAmount: number;
  heldAmount: number;
  availableAmount: number;
  originalSplits: PartyAmounts;
  cumulativeRefundedSplits: PartyAmounts;
  netSplits: PartyAmounts;
  refunds: RefundRecord[];
  entries: LedgerEntry[];
}
