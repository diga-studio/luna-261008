import { HOLD_MS, METRICS, WINDOW_HOURS } from "./types.js";
import type { Heartbeat, Metric, RankEntry, WindowHours } from "./types.js";

export type { Metric, RankEntry, WindowHours } from "./types.js";
export { HOLD_MS, METRICS, WINDOW_HOURS } from "./types.js";

const HOUR_MS = 3_600_000;
const MAX_WINDOW_MS = 72 * HOUR_MS;

function assertMetric(metric: Metric): void {
  if (!METRICS.includes(metric)) {
    throw new Error(`unknown metric: ${String(metric)}`);
  }
}

function assertWindowHours(windowHours: WindowHours): void {
  if (!WINDOW_HOURS.includes(windowHours)) {
    throw new Error(`unsupported windowHours: ${String(windowHours)}`);
  }
}

/**
 * Production ranker: evicts expired data on clock advancement while
 * guaranteeing results identical to the full-history reference.
 *
 * A heartbeat at t holds its values over [t, min(nextT, t + HOLD_MS)).
 * Eviction drops every heartbeat whose maximum possible interval end
 * (t + HOLD_MS) is at or before now - 72h: such intervals can never
 * intersect any current or future query window, and dropping them cannot
 * distort a surviving neighbor's interval inside the window either.
 */
export class HeartbeatRanker {
  private readonly heartbeats = new Map<string, Heartbeat[]>();
  private nowMs: number;

  constructor(nodeIds: readonly string[], clockMs: number) {
    if (!Number.isInteger(clockMs)) {
      throw new Error(`clockMs must be an integer, got ${clockMs}`);
    }
    for (const id of nodeIds) {
      if (this.heartbeats.has(id)) {
        throw new Error(`duplicate nodeId: ${id}`);
      }
      this.heartbeats.set(id, []);
    }
    this.nowMs = clockMs;
  }

  ingest(
    nodeId: string,
    timestampMs: number,
    cpu: number,
    memory: number,
    disk: number,
  ): void {
    const list = this.heartbeats.get(nodeId);
    if (!list) throw new Error(`unknown nodeId: ${nodeId}`);
    if (!Number.isInteger(timestampMs)) {
      throw new Error(`timestampMs must be an integer, got ${timestampMs}`);
    }
    for (const [name, value] of [
      ["cpu", cpu],
      ["memory", memory],
      ["disk", disk],
    ] as const) {
      if (!Number.isInteger(value)) {
        throw new Error(`${name} must be an integer, got ${value}`);
      }
    }
    const idx = lowerBound(list, timestampMs);
    if (idx < list.length && list[idx].timestampMs === timestampMs) {
      throw new Error(`duplicate timestamp ${timestampMs} for node ${nodeId}`);
    }
    list.splice(idx, 0, { timestampMs, cpu, memory, disk });
  }

  advanceTo(nowMs: number): void {
    if (!Number.isInteger(nowMs)) {
      throw new Error(`nowMs must be an integer, got ${nowMs}`);
    }
    if (nowMs < this.nowMs) {
      throw new Error(`clock cannot go backwards: ${nowMs} < ${this.nowMs}`);
    }
    this.nowMs = nowMs;
    const cutoff = nowMs - MAX_WINDOW_MS;
    for (const list of this.heartbeats.values()) {
      let drop = 0;
      while (drop < list.length && list[drop].timestampMs + HOLD_MS <= cutoff) {
        drop++;
      }
      if (drop > 0) list.splice(0, drop);
    }
  }

  top(windowHours: WindowHours, metric: Metric): RankEntry[] {
    assertWindowHours(windowHours);
    assertMetric(metric);
    const windowStart = this.nowMs - windowHours * HOUR_MS;
    const windowEnd = this.nowMs;
    const entries: RankEntry[] = [];
    for (const [nodeId, list] of this.heartbeats) {
      let integral = 0n;
      let coverage = 0n;
      const first = lowerBound(list, windowStart - HOLD_MS + 1);
      for (let i = first; i < list.length; i++) {
        const start = list[i].timestampMs;
        if (start >= windowEnd) break;
        const next =
          i + 1 < list.length ? list[i + 1].timestampMs : Number.POSITIVE_INFINITY;
        const end = Math.min(next, start + HOLD_MS);
        const lo = Math.max(start, windowStart);
        const hi = Math.min(end, windowEnd);
        if (lo < hi) {
          const len = BigInt(hi - lo);
          coverage += len;
          integral += BigInt(list[i][metric]) * len;
        }
      }
      if (coverage > 0n) {
        entries.push({
          nodeId,
          integral,
          coverageMs: coverage,
          mean: Number(integral) / Number(coverage),
        });
      }
    }
    entries.sort(compareEntries);
    return entries;
  }
}

function compareEntries(a: RankEntry, b: RankEntry): number {
  const lhs = a.integral * b.coverageMs;
  const rhs = b.integral * a.coverageMs;
  if (lhs !== rhs) return lhs > rhs ? -1 : 1;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/** Index of the first heartbeat with timestampMs >= target. */
function lowerBound(list: readonly Heartbeat[], target: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].timestampMs < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
