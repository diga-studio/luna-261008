import { withinCap105, withinTolerance } from './num.js';

/** 订单行主键。 */
export function lineKey(orderId: string, lineId: string): string {
  return JSON.stringify([orderId, lineId]);
}

export interface OrderLineState {
  orderId: string;
  lineId: string;
  qty: bigint;
  priceCents: bigint;
}

export interface InvoiceLineState {
  key: string;
  qty: bigint;
  amountCents: bigint;
}

export interface InvoiceState {
  invoiceId: string;
  seq: number;
  voided: boolean;
  /** 已按订单行聚合（同票同订单行的多行已求和）。 */
  lines: InvoiceLineState[];
}

/** 单票自身校验：每行金额与该行票量基准的偏差不超过 2%（基准为零时金额必须为零）。 */
function intrinsicallyValid(
  invoice: InvoiceState,
  orderLines: ReadonlyMap<string, OrderLineState>,
): boolean {
  if (invoice.lines.length === 0) {
    return false;
  }
  for (const line of invoice.lines) {
    const orderLine = orderLines.get(line.key);
    if (orderLine === undefined) {
      return false;
    }
    if (!withinTolerance(line.amountCents, line.qty, orderLine.priceCents)) {
      return false;
    }
  }
  return true;
}

/**
 * 依据当前有效数据从头分配额度，不保留旧匹配资格。
 * 每轮按首次登记序号扫描，最早能整票加入的有效发票先获得额度；
 * 不满足者不阻塞更晚候选；分配持续到没有可加入的发票。
 * 返回可结算（SETTLED）发票 id 集合。
 */
export function allocate(
  orderLines: ReadonlyMap<string, OrderLineState>,
  qualifiedQty: ReadonlyMap<string, bigint>,
  invoices: readonly InvoiceState[],
): Set<string> {
  const settled = new Set<string>();
  const cumQty = new Map<string, bigint>();
  const cumAmount = new Map<string, bigint>();

  // 未结算候选列表：加入成功的票立即移除，扫描不再重复经过已结算票。
  const remaining = invoices
    .filter((inv) => !inv.voided && intrinsicallyValid(inv, orderLines))
    .sort((a, b) => a.seq - b.seq);

  const canAdd = (invoice: InvoiceState): boolean => {
    for (const line of invoice.lines) {
      const orderLine = orderLines.get(line.key);
      if (orderLine === undefined) {
        return false;
      }
      const nextQty = (cumQty.get(line.key) ?? 0n) + line.qty;
      const nextAmount = (cumAmount.get(line.key) ?? 0n) + line.amountCents;
      if (!withinCap105(nextQty, orderLine.qty)) {
        return false;
      }
      if (!withinCap105(nextQty, qualifiedQty.get(line.key) ?? 0n)) {
        return false;
      }
      if (!withinTolerance(nextAmount, nextQty, orderLine.priceCents)) {
        return false;
      }
    }
    return true;
  };

  let added = true;
  while (added) {
    added = false;
    for (let i = 0; i < remaining.length; i++) {
      const invoice = remaining[i];
      if (invoice === undefined || !canAdd(invoice)) {
        continue;
      }
      remaining.splice(i, 1);
      settled.add(invoice.invoiceId);
      for (const line of invoice.lines) {
        cumQty.set(line.key, (cumQty.get(line.key) ?? 0n) + line.qty);
        cumAmount.set(line.key, (cumAmount.get(line.key) ?? 0n) + line.amountCents);
      }
      added = true;
      break;
    }
  }
  return settled;
}
