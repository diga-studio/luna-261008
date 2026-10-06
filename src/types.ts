/** 数量：千分之一采购单位的整数；金额/单价：分的整数。一律用 bigint 保证 18 位精确。 */

export interface PoLineInput {
  lineId: string;
  /** 订购数量（千分之一单位） */
  orderedQty: bigint;
  /** 合同单价（分） */
  unitPrice: bigint;
}

export interface PurchaseOrderInput {
  poId: string;
  currency: string;
  lines: PoLineInput[];
}

export interface ReceiptLineInput {
  poId: string;
  poLineId: string;
  /** 合格数量（千分之一单位） */
  qtyQualified: bigint;
  /** 待检数量 */
  qtyPending: bigint;
  /** 不合格数量 */
  qtyRejected: bigint;
}

export interface ReceiptInput {
  receiptId: string;
  lines: ReceiptLineInput[];
}

export interface InvoiceLineInput {
  poId: string;
  poLineId: string;
  /** 票量（千分之一单位） */
  qty: bigint;
  /** 金额（分） */
  amount: bigint;
}

export interface InvoiceInput {
  invoiceId: string;
  currency: string;
  lines: InvoiceLineInput[];
}

export type WriteStatus =
  | 'applied' // 本次生效
  | 'duplicate' // 同号同内容重试，无新增副作用
  | 'conflict'; // 同号不同内容，数据未变

export interface WriteResult {
  status: WriteStatus;
}

export type InvoiceState = 'settleable' | 'pending' | 'voided';

export interface InvoiceSnapshot {
  invoiceId: string;
  /** 首次成功登记序号（从 1 递增） */
  seq: number;
  state: InvoiceState;
}

export interface PoLineSnapshot {
  poId: string;
  poLineId: string;
  orderedQty: bigint;
  unitPrice: bigint;
  /** 当前合格收货量 */
  qualifiedQty: bigint;
  /** 已核销票量（可结算票合计） */
  matchedQty: bigint;
  /** 已核销票额（分） */
  matchedAmount: bigint;
}

export interface Snapshot {
  invoices: InvoiceSnapshot[];
  lines: PoLineSnapshot[];
}
