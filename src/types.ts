export type Currency = 'USD' | 'EUR' | 'GBP';

export type Party = 'merchant' | 'platform' | 'partner';

export const PARTIES: readonly Party[] = ['merchant', 'platform', 'partner'];

export type RefundStatus = 'processing' | 'succeeded' | 'failed';

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
  original: PartyAmounts;
}

export interface RefundRequest {
  merchantId: string;
  paymentId: string;
  idempotencyKey: string;
  amount: number;
}

export type RefundResultKind = 'processing' | 'succeeded' | 'failed';

export interface RefundResult {
  merchantId: string;
  paymentId: string;
  idempotencyKey: string;
  kind: RefundResultKind;
}

export interface RefundView {
  idempotencyKey: string;
  amount: number;
  status: RefundStatus;
}

export interface LedgerEntry {
  seq: number;
  currency: Currency;
  debitAccount: string;
  creditAccount: string;
  amount: number;
  refundKey: string | null;
  memo: string;
}

export interface PaymentLedgerView {
  merchantId: string;
  paymentId: string;
  currency: Currency;
  totalAmount: number;
  original: PartyAmounts;
  refundedTotal: number;
  reservedTotal: number;
  cumulativeDue: PartyAmounts;
  netAmounts: PartyAmounts;
  refundClearingReceived: number;
  refunds: RefundView[];
  entries: LedgerEntry[];
}
