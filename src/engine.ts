import { withinTolerance } from './money.js';
import type { InvoiceState } from './types.js';

export interface EngineLine {
  poId: string;
  poLineId: string;
  orderedQty: bigint;
  unitPrice: bigint;
  qualifiedQty: bigint;
}

export interface EngineInvoice {
  invoiceId: string;
  seq: number;
  voided: boolean;
  lines: { poId: string; poLineId: string; qty: bigint; amount: bigint }[];
}

export interface AllocationResult {
  invoiceState: Map<string, InvoiceState>;
  /** key: `${poId}/${poLineId}` */
  matchedQty: Map<string, bigint>;
  matchedAmount: Map<string, bigint>;
}

function lineKey(poId: string, poLineId: string): string {
  return `${poId}/${poLineId}`;
}

/** 累计量是否不超过基准量的 105%（等于边界允许）。整数比较，不近似。 */
function withinCap(total: bigint, base: bigint): boolean {
  return total * 100n <= base * 105n;
}

/**
 * 按优先级从当前有效数据重新分配额度（纯函数，不保留旧匹配资格）。
 * 每轮按首次登记序号升序扫描，能整票加入的最早发票先获得额度；
 * 不满足者不阻塞更晚候选；重复扫描直到一轮内没有新加入的发票。
 */
export function allocate(lines: EngineLine[], invoices: EngineInvoice[]): AllocationResult {
  const lineMap = new Map<string, EngineLine>();
  for (const l of lines) {
    lineMap.set(lineKey(l.poId, l.poLineId), l);
  }

  const matchedQty = new Map<string, bigint>();
  const matchedAmount = new Map<string, bigint>();
  const invoiceState = new Map<string, InvoiceState>();

  const candidates = invoices
    .filter((inv) => !inv.voided)
    .sort((a, b) => a.seq - b.seq);
  for (const inv of invoices) {
    if (inv.voided) invoiceState.set(inv.invoiceId, 'voided');
  }
  const settled = new Set<string>();

  const canJoin = (inv: EngineInvoice): [boolean, Map<string, { qty: bigint; amount: bigint }>] => {
    // 同一订单行合计
    const groups = new Map<string, { qty: bigint; amount: bigint }>();
    for (const l of inv.lines) {
      const k = lineKey(l.poId, l.poLineId);
      const g = groups.get(k) ?? { qty: 0n, amount: 0n };
      g.qty += l.qty;
      g.amount += l.amount;
      groups.set(k, g);
    }
    for (const [k, g] of groups) {
      const line = lineMap.get(k);
      if (!line) return [false, groups];
      // 单票偏差 <= 2%
      if (!withinTolerance(g.amount, g.qty, line.unitPrice)) return [false, groups];
      const cumQty = (matchedQty.get(k) ?? 0n) + g.qty;
      const cumAmount = (matchedAmount.get(k) ?? 0n) + g.amount;
      // 累计偏差 <= 2%
      if (!withinTolerance(cumAmount, cumQty, line.unitPrice)) return [false, groups];
      // 累计票量 <= min(订购量, 当前合格收货量) 的 105%
      if (!withinCap(cumQty, line.orderedQty)) return [false, groups];
      if (!withinCap(cumQty, line.qualifiedQty)) return [false, groups];
    }
    return [true, groups];
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const inv of candidates) {
      if (settled.has(inv.invoiceId)) continue;
      const [ok, groups] = canJoin(inv);
      if (!ok) continue;
      for (const [k, g] of groups) {
        matchedQty.set(k, (matchedQty.get(k) ?? 0n) + g.qty);
        matchedAmount.set(k, (matchedAmount.get(k) ?? 0n) + g.amount);
      }
      settled.add(inv.invoiceId);
      changed = true;
    }
  }

  for (const inv of candidates) {
    invoiceState.set(inv.invoiceId, settled.has(inv.invoiceId) ? 'settleable' : 'pending');
  }
  return { invoiceState, matchedQty, matchedAmount };
}
