import type { Heartbeat, MetricKind, RankEntry, WindowHours } from './types.js';

/** A heartbeat holds its value for at most this long after its timestamp. */
export const MAX_HOLD_MS = 300_000;

const HOUR_MS = 3_600_000;
const MAX_WINDOW_HOURS = 72;
const VALID_WINDOWS: readonly number[] = [1, 6, 12, 24, 48, 72];

export class HeartbeatRanker {
  private nowMs: number;
  /** Per-node heartbeats, each array sorted ascending by timestampMs. */
  private readonly nodes: Map<string, Heartbeat[]>;

  constructor(nodeIds: readonly string[], nowMs: number) {
    if (!Number.isFinite(nowMs)) {
      throw new Error(`invalid initial clock: ${nowMs}`);
    }
    this.nowMs = nowMs;
    this.nodes = new Map();
    for (const nodeId of nodeIds) {
      if (this.nodes.has(nodeId)) {
        throw new Error(`duplicate nodeId: ${nodeId}`);
      }
      this.nodes.set(nodeId, []);
    }
  }

  /** Current clock position in UTC milliseconds. */
  get clockMs(): number {
    return this.nowMs;
  }

  ingest(nodeId: string, timestampMs: number, cpu: number, memory: number, disk: number): void {
    const beats = this.nodes.get(nodeId);
    if (beats === undefined) {
      throw new Error(`unknown nodeId: ${nodeId}`);
    }
    for (const [name, value] of [['cpu', cpu], ['memory', memory], ['disk', disk]] as const) {
      if (!Number.isInteger(value)) {
        throw new Error(`${name} must be an integer (hundredths of a percent), got ${value}`);
      }
    }
    if (!Number.isFinite(timestampMs)) {
      throw new Error(`invalid timestampMs: ${timestampMs}`);
    }
    const beat: Heartbeat = { timestampMs, cpu, memory, disk };
    // Binary search for the insertion point; timestamps are unique per node.
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (beats[mid]!.timestampMs < timestampMs) lo = mid + 1;
      else hi = mid;
    }
    if (lo < beats.length && beats[lo]!.timestampMs === timestampMs) {
      throw new Error(`duplicate timestamp ${timestampMs} for node ${nodeId}`);
    }
    beats.splice(lo, 0, beat);
  }

  advanceTo(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new Error(`invalid nowMs: ${nowMs}`);
    }
    if (nowMs < this.nowMs) {
      throw new Error(`clock must advance monotonically: ${nowMs} < ${this.nowMs}`);
    }
    this.nowMs = nowMs;
    // A heartbeat at t can only influence windows starting before t + MAX_HOLD_MS,
    // and the widest window starts at now - 72h. Older beats are evicted.
    const cutoff = this.nowMs - MAX_WINDOW_HOURS * HOUR_MS - MAX_HOLD_MS;
    for (const beats of this.nodes.values()) {
      let drop = 0;
      while (drop < beats.length && beats[drop]!.timestampMs <= cutoff) drop++;
      if (drop > 0) beats.splice(0, drop);
    }
  }

  top(windowHours: WindowHours, metric: MetricKind): RankEntry[] {
    if (!VALID_WINDOWS.includes(windowHours)) {
      throw new Error(`unsupported windowHours: ${windowHours}`);
    }
    const windowStart = this.nowMs - windowHours * HOUR_MS;
    const windowEnd = this.nowMs;
    const entries: RankEntry[] = [];
    for (const [nodeId, beats] of this.nodes) {
      // First index whose hold interval could reach into the window.
      let lo = 0;
      let hi = beats.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (beats[mid]!.timestampMs + MAX_HOLD_MS <= windowStart) lo = mid + 1;
        else hi = mid;
      }
      let integral = 0;
      let coverageMs = 0;
      for (let i = lo; i < beats.length; i++) {
        const beat = beats[i]!;
        if (beat.timestampMs >= windowEnd) break;
        const nextTs = i + 1 < beats.length ? beats[i + 1]!.timestampMs : Number.POSITIVE_INFINITY;
        const holdEnd = Math.min(beat.timestampMs + MAX_HOLD_MS, nextTs);
        const start = Math.max(beat.timestampMs, windowStart);
        const end = Math.min(holdEnd, windowEnd);
        if (start < end) {
          const span = end - start;
          integral += beat[metric] * span;
          coverageMs += span;
        }
      }
      if (coverageMs > 0) {
        entries.push({ nodeId, integral, coverageMs, mean: integral / coverageMs });
      }
    }
    entries.sort((a, b) => {
      // Exact comparison of unrounded means via BigInt cross-multiplication.
      const lhs = BigInt(a.integral) * BigInt(b.coverageMs);
      const rhs = BigInt(b.integral) * BigInt(a.coverageMs);
      if (lhs !== rhs) return lhs > rhs ? -1 : 1;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });
    return entries;
  }
}
