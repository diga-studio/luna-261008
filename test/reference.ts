import type { Heartbeat, MetricKind, RankEntry, WindowHours } from '../src/types.js';

const HOUR_MS = 3_600_000;
const MAX_HOLD_MS = 300_000;

/**
 * Deliberately naive reference: keeps the full history forever (no eviction),
 * and computes each query by sweeping elementary segments between all
 * boundary points instead of intersecting per-heartbeat hold intervals.
 */
export class ReferenceRanker {
  private nowMs: number;
  private readonly nodes: Map<string, Heartbeat[]>;

  constructor(nodeIds: readonly string[], nowMs: number) {
    this.nowMs = nowMs;
    this.nodes = new Map(nodeIds.map((id) => [id, []]));
  }

  ingest(nodeId: string, timestampMs: number, cpu: number, memory: number, disk: number): void {
    const beats = this.nodes.get(nodeId);
    if (!beats) throw new Error(`unknown nodeId: ${nodeId}`);
    beats.push({ timestampMs, cpu, memory, disk });
  }

  advanceTo(nowMs: number): void {
    if (nowMs < this.nowMs) throw new Error('non-monotonic clock');
    this.nowMs = nowMs;
  }

  top(windowHours: WindowHours, metric: MetricKind): RankEntry[] {
    const windowStart = this.nowMs - windowHours * HOUR_MS;
    const windowEnd = this.nowMs;
    const entries: RankEntry[] = [];
    for (const [nodeId, beats] of this.nodes) {
      const sorted = [...beats].sort((a, b) => a.timestampMs - b.timestampMs);
      // Candidate segment boundaries inside the window.
      const cuts = new Set<number>([windowStart, windowEnd]);
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i]!.timestampMs;
        const holdEnd = Math.min(
          t + MAX_HOLD_MS,
          i + 1 < sorted.length ? sorted[i + 1]!.timestampMs : Number.POSITIVE_INFINITY,
        );
        if (t > windowStart && t < windowEnd) cuts.add(t);
        if (holdEnd > windowStart && holdEnd < windowEnd) cuts.add(holdEnd);
      }
      const points = [...cuts].sort((a, b) => a - b);
      let integral = 0;
      let coverageMs = 0;
      for (let s = 0; s + 1 < points.length; s++) {
        const segStart = points[s]!;
        const segEnd = points[s + 1]!;
        if (segStart >= segEnd) continue;
        // Covering beat: latest beat with t <= segStart whose hold reaches past segStart.
        let value: number | null = null;
        for (let i = 0; i < sorted.length; i++) {
          const beat = sorted[i]!;
          if (beat.timestampMs > segStart) break;
          const nextTs = i + 1 < sorted.length ? sorted[i + 1]!.timestampMs : Number.POSITIVE_INFINITY;
          if (segStart < Math.min(beat.timestampMs + MAX_HOLD_MS, nextTs)) {
            value = beat[metric];
          }
        }
        if (value !== null) {
          integral += value * (segEnd - segStart);
          coverageMs += segEnd - segStart;
        }
      }
      if (coverageMs > 0) {
        entries.push({ nodeId, integral, coverageMs, mean: integral / coverageMs });
      }
    }
    entries.sort((a, b) => {
      const lhs = BigInt(a.integral) * BigInt(b.coverageMs);
      const rhs = BigInt(b.integral) * BigInt(a.coverageMs);
      if (lhs !== rhs) return lhs > rhs ? -1 : 1;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });
    return entries;
  }
}
