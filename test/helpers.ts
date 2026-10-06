import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostLens } from "../src/index.js";
import type { BillingRecord } from "../src/index.js";

export function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "costlens-")), "billing.db");
}

export function freshLens(): { lens: CostLens; dbPath: string } {
  const dbPath = freshDbPath();
  return { lens: new CostLens(dbPath), dbPath };
}

/** Split bytes into chunks of the given size (last chunk may be smaller). */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.subarray(i, Math.min(i + size, bytes.length)));
  }
  return chunks;
}

export async function* toStream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

export function csvBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export async function readAll(lens: CostLens, accountId: string): Promise<BillingRecord[]> {
  const out: BillingRecord[] = [];
  for await (const rec of lens.readBilling(accountId)) out.push(rec);
  return out;
}

export const HEADER = "resource_id,usage_date,usage_quantity,unit_cost,total_cost";

/**
 * Independent reference: exact decimal multiplication rounded half-even
 * to cents, computed with BigInt only. Returns decimal text with 2 places.
 */
export function refTotal(quantity: string, unitCost: string): string {
  const parse = (t: string): { scaled: bigint; scale: number } => {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t)!;
    const frac = m[3] ?? "";
    let scaled = BigInt(m[2]! + frac);
    if (m[1] === "-") scaled = -scaled;
    return { scaled, scale: frac.length };
  };
  const q = parse(quantity);
  const u = parse(unitCost);
  let product = q.scaled * u.scaled;
  const scale = q.scale + u.scale;
  let cents: bigint;
  if (scale <= 2) {
    cents = product * 10n ** BigInt(2 - scale);
  } else {
    const div = 10n ** BigInt(scale - 2);
    const neg = product < 0n;
    const abs = neg ? -product : product;
    const quo = abs / div;
    const rem = (abs % div) * 2n;
    let r = rem > div ? quo + 1n : rem < div ? quo : quo % 2n === 0n ? quo : quo + 1n;
    cents = neg ? -r : r;
    product = 0n;
  }
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const intPart = abs / 100n;
  const fracPart = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${intPart}.${fracPart}`;
}
