/** 整数输入：分的金额、千分之一采购单位的数量。内部一律按 bigint 精确处理。 */
export type IntInput = bigint | number | string;

/** 采购订单行：订购数量（千分之一单位）与合同单价（分）。 */
export interface OrderLineInput {
  lineId: string;
  qty: IntInput;
  priceCents: IntInput;
}

export interface OrderInput {
  orderId: string;
  currency: string;
  lines: OrderLineInput[];
}

/** 收货行：按质检状态分列数量，仅合格数量提供核销额度。 */
export interface ReceiptLineInput {
  orderId: string;
  lineId: string;
  qualified: IntInput;
  pending: IntInput;
  unqualified: IntInput;
}

/** 收货单；同一 receiptId 再次登记即为更正，整体替换原内容。 */
export interface ReceiptInput {
  receiptId: string;
  lines: ReceiptLineInput[];
}

/** 发票行：指向采购订单行，给出票量与金额（分）。 */
export interface InvoiceLineInput {
  orderId: string;
  lineId: string;
  qty: IntInput;
  amountCents: IntInput;
}

export interface InvoiceInput {
  invoiceId: string;
  lines: InvoiceLineInput[];
}

export type InvoiceStatus = 'SETTLED' | 'PENDING' | 'VOIDED';

export interface InvoiceSnapshot {
  invoiceId: string;
  /** 首次成功登记的序号，决定分配优先级。 */
  seq: number;
  status: InvoiceStatus;
}

export interface OrderLineSnapshot {
  orderId: string;
  lineId: string;
  /** 当前合格收货量（千分之一单位）。 */
  qualifiedQty: bigint;
  /** 累计核销票量（千分之一单位）。 */
  matchedQty: bigint;
  /** 累计核销票额（分）。 */
  matchedAmountCents: bigint;
  /** 核销票量对应的基准金额（分，仅此处四舍五入，半分向上）。 */
  baselineCents: bigint;
}

export interface Snapshot {
  invoices: InvoiceSnapshot[];
  lines: OrderLineSnapshot[];
}
