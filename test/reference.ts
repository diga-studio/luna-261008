import { WINDOW_MS, type AnomalyInterval, type RequestRecord } from "../src/index.js";

/**
 * Independent brute-force reference: rebuilds all window-count change events
 * from the full record set and sweeps them in time order. Used to cross-check
 * the incremental library against a from-scratch recomputation.
 */
export function referenceAnomalyIntervals(
  records: ReadonlyArray<RequestRecord>,
  service: string,
  fromMs: number,
  toMs: number,
): AnomalyInterval[] {
  const deltas = new Map<number, { dn: number; de: number }>();
  for (const record of records) {
    if (record.service !== service) continue;
    const err = record.statusCode >= 500 && record.statusCode <= 599 ? 1 : 0;
    for (const [t, dn, de] of [
      [record.timestampMs, 1, err],
      [record.timestampMs + WINDOW_MS, -1, -err],
    ] as const) {
      const slot = deltas.get(t) ?? { dn: 0, de: 0 };
      slot.dn += dn;
      slot.de += de;
      deltas.set(t, slot);
    }
  }
  const times = [...deltas.keys()].sort((a, b) => a - b);
  const out: AnomalyInterval[] = [];
  let total = 0;
  let errors = 0;
  for (let i = 0; i < times.length; i++) {
    const slot = deltas.get(times[i]!)!;
    total += slot.dn;
    errors += slot.de;
    if (errors * 20 > total) {
      const segEnd = i + 1 < times.length ? times[i + 1]! : Infinity;
      const s = Math.max(times[i]!, fromMs);
      const e = Math.min(segEnd, toMs);
      if (s < e) {
        const last = out[out.length - 1];
        if (last !== undefined && last.endMs === s) last.endMs = e;
        else out.push({ startMs: s, endMs: e });
      }
    }
  }
  return out;
}
