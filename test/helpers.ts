import type { AnomalyInterval, RequestRecord } from "../src/types";
import { WINDOW_MS } from "../src/analyzer";

/** Deterministic PRNG (mulberry32) for reproducible tests. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Independent brute-force reference: recomputes anomalous intervals for
 * `service` inside [startMs, endMs) directly from the full record list.
 *
 * The anomalous status only changes at event times (a request entering
 * at its timestamp or leaving WINDOW_MS later), so the status is uniform
 * over each elementary segment between consecutive event times and can
 * be evaluated at the segment start with the (t - WINDOW_MS, t] rule.
 */
export function bruteForceAnomalyIntervals(
  records: readonly RequestRecord[],
  service: string,
  startMs: number,
  endMs: number,
): AnomalyInterval[] {
  const out: AnomalyInterval[] = [];
  if (startMs >= endMs) return out;
  const recs = records.filter((r) => r.service === service);
  const points = new Set<number>([startMs]);
  for (const r of recs) {
    if (r.timestampMs > startMs && r.timestampMs < endMs) points.add(r.timestampMs);
    const leave = r.timestampMs + WINDOW_MS;
    if (leave > startMs && leave < endMs) points.add(leave);
  }
  const sorted = [...points].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    const segStart = sorted[i] as number;
    const segEnd = i + 1 < sorted.length ? (sorted[i + 1] as number) : endMs;
    if (segStart >= segEnd) continue;
    let total = 0;
    let errors = 0;
    for (const r of recs) {
      if (r.timestampMs > segStart - WINDOW_MS && r.timestampMs <= segStart) {
        total += 1;
        if (r.status >= 500 && r.status <= 599) errors += 1;
      }
    }
    if (total > 0 && errors * 20 > total) {
      const last = out.length > 0 ? out[out.length - 1] : undefined;
      if (last !== undefined && last.endMs === segStart) {
        (last as { endMs: number }).endMs = segEnd;
      } else {
        out.push({ startMs: segStart, endMs: segEnd });
      }
    }
  }
  return out;
}

/**
 * O(n log n) sweep-line reference over columnar data (single service):
 * sorts all window entry/exit events, then walks the timeline tracking
 * the current weight (errors weigh 19, successes -1, so anomalous
 * is exactly weight > 0). Only the first `count` slots are read.
 */
export function sweepAnomalyIntervalsFromColumns(
  timestamps: Float64Array,
  statuses: Int32Array,
  count: number,
  startMs: number,
  endMs: number,
): AnomalyInterval[] {
  const out: AnomalyInterval[] = [];
  if (startMs >= endMs) return out;
  const times = new Float64Array(count * 2);
  const deltas = new Int32Array(count * 2);
  let n = 0;
  for (let i = 0; i < count; i += 1) {
    const status = statuses[i] as number;
    const weight = status >= 500 && status <= 599 ? 19 : -1;
    const ts = timestamps[i] as number;
    times[n] = ts;
    deltas[n] = weight;
    n += 1;
    times[n] = ts + WINDOW_MS;
    deltas[n] = -weight;
    n += 1;
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  order.sort((a, b) => (times[a] as number) - (times[b] as number));
  let weight = 0;
  let i = 0;
  while (i < n) {
    const t = times[order[i] as number] as number;
    let j = i;
    while (j < n && (times[order[j] as number] as number) === t) {
      weight += deltas[order[j] as number] as number;
      j += 1;
    }
    const next = j < n ? (times[order[j] as number] as number) : Infinity;
    if (weight > 0) {
      const s = Math.max(t, startMs);
      const e = Math.min(next, endMs);
      if (s < e) {
        const last = out.length > 0 ? out[out.length - 1] : undefined;
        if (last !== undefined && last.endMs === s) {
          (last as { endMs: number }).endMs = e;
        } else {
          out.push({ startMs: s, endMs: e });
        }
      }
    }
    i = j;
  }
  return out;
}

/** Formats intervals compactly for assertion messages. */
export function formatIntervals(intervals: readonly AnomalyInterval[]): string {
  return `[${intervals.map((i) => `[${i.startMs}, ${i.endMs})`).join(", ")}]`;
}
