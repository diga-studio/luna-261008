import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '../src/index.js';

export function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'recon-')), 'test.db');
}

function keyOf(orderId: string, lineId: string): string {
  return JSON.stringify([orderId, lineId]);
}

export interface RefOrderLine {
  orderId: string;
  lineId: string;
  qty: bigint;
  priceCents: bigint;
}

export interface RefInvoiceLine {
  orderId: string;
  lineId: string;
  qty: bigint;
  amountCents: bigint;
}

export interface RefInvoice {
  invoiceId: string;
  /** 首次成功登记序号。 */
  seq: number;
  voided: boolean;
  /** 按订单行聚合后的行。 */
  lines: RefInvoiceLine[];
}

function roundHalfUp(milli: bigint): bigint {
  return (milli + 500n) / 1000n;
}

function withinTol(amount: bigint, qty: bigint, price: bigint): boolean {
  const base = roundHalfUp(qty * price);
  if (base === 0n) return amount === 0n;
  const diff = amount > base ? amount - base : base - amount;
  return diff * 50n <= base;
}

/**
 * 独立参考实现：从当前有效数据按“最早可整票加入者优先”重算快照，
 * 用于与 ReconciliationStore 的结果比对。
 */
export function referenceSnapshot(
  orderLines: readonly RefOrderLine[],
  qualified: ReadonlyMap<string, bigint>,
  invoices: readonly RefInvoice[],
): Snapshot {
  const catalog = new Map(orderLines.map((l) => [keyOf(l.orderId, l.lineId), l]));
  const alive = invoices
    .filter((inv) => !inv.voided)
    .filter((inv) =>
      inv.lines.every((l) => {
        const ol = catalog.get(keyOf(l.orderId, l.lineId));
        return ol !== undefined && withinTol(l.amountCents, l.qty, ol.priceCents);
      }),
    )
    .sort((a, b) => a.seq - b.seq);

  const settled = new Set<string>();
  const cumQty = new Map<string, bigint>();
  const cumAmt = new Map<string, bigint>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const inv of alive) {
      if (settled.has(inv.invoiceId)) continue;
      const ok = inv.lines.every((l) => {
        const key = keyOf(l.orderId, l.lineId);
        const ol = catalog.get(key);
        if (ol === undefined) return false;
        const nq = (cumQty.get(key) ?? 0n) + l.qty;
        const na = (cumAmt.get(key) ?? 0n) + l.amountCents;
        return (
          nq * 20n <= ol.qty * 21n &&
          nq * 20n <= (qualified.get(key) ?? 0n) * 21n &&
          withinTol(na, nq, ol.priceCents)
        );
      });
      if (!ok) continue;
      settled.add(inv.invoiceId);
      for (const l of inv.lines) {
        const key = keyOf(l.orderId, l.lineId);
        cumQty.set(key, (cumQty.get(key) ?? 0n) + l.qty);
        cumAmt.set(key, (cumAmt.get(key) ?? 0n) + l.amountCents);
      }
      progress = true;
      break;
    }
  }

  return {
    invoices: invoices
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((inv) => ({
        invoiceId: inv.invoiceId,
        seq: inv.seq,
        status: inv.voided ? 'VOIDED' : settled.has(inv.invoiceId) ? 'SETTLED' : 'PENDING',
      })),
    lines: orderLines
      .slice()
      .sort((a, b) =>
        a.orderId === b.orderId
          ? a.lineId.localeCompare(b.lineId)
          : a.orderId.localeCompare(b.orderId),
      )
      .map((ol) => {
        const key = keyOf(ol.orderId, ol.lineId);
        const qty = cumQty.get(key) ?? 0n;
        return {
          orderId: ol.orderId,
          lineId: ol.lineId,
          qualifiedQty: qualified.get(key) ?? 0n,
          matchedQty: qty,
          matchedAmountCents: cumAmt.get(key) ?? 0n,
          baselineCents: roundHalfUp(qty * ol.priceCents),
        };
      }),
  };
}
