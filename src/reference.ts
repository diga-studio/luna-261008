import { HOLD_MS } from "./types.js";
import type { Heartbeat, Metric, RankEntry, WindowHours } from "./types.js";

const HOUR_MS = 3_600_000;

/**
 * Reference implementation: keeps the full heartbeat history and computes
 * rankings by brute force over the time-sorted history. Used to validate
 * the production implementation in tests.
 */
export class ReferenceRanker {
  private readonly nodeIds: ReadonlySet<string>;
  private readonly heartbeats = new Map<string, Heartbeat[]>();
  private nowMs: number;

  constructor(nodeIds: readonly string[], clockMs: number) {
    this.nodeIds = new Set(nodeIds);
    for (const id of nodeIds) this.heartbeats.set(id, []);
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
    if (list.some((h) => h.timestampMs === timestampMs)) {
      throw new Error(`duplicate timestamp ${timestampMs} for node ${nodeId}`);
    }
    list.push({ timestampMs, cpu, memory, disk });
  }

  advanceTo(nowMs: number): void {
    if (nowMs < this.nowMs) {
      throw new Error(`clock cannot go backwards: ${nowMs} < ${this.nowMs}`);
    }
    this.nowMs = nowMs;
  }

  top(windowHours: WindowHours, metric: Metric): RankEntry[] {
    const windowStart = this.nowMs - windowHours * HOUR_MS;
    const windowEnd = this.nowMs;
    const entries: RankEntry[] = [];
    for (const [nodeId, list] of this.heartbeats) {
      const sorted = [...list].sort((a, b) => a.timestampMs - b.timestampMs);
      let integral = 0n;
      let coverage = 0n;
      for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i].timestampMs;
        const next =
          i + 1 < sorted.length ? sorted[i + 1].timestampMs : Number.POSITIVE_INFINITY;
        const end = Math.min(next, start + HOLD_MS);
        const lo = Math.max(start, windowStart);
        const hi = Math.min(end, windowEnd);
        if (lo < hi) {
          const len = BigInt(hi - lo);
          coverage += len;
          integral += BigInt(sorted[i][metric]) * len;
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
    entries.sort((a, b) => {
      const lhs = a.integral * b.coverageMs;
      const rhs = b.integral * a.coverageMs;
      if (lhs !== rhs) return lhs > rhs ? -1 : 1;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });
    return entries;
  }
}
