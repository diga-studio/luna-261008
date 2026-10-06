import { test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { AlertAnalyzer } from "../src/analyzer";
import { mulberry32, sweepAnomalyIntervalsFromColumns } from "./helpers";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const SPAN = 90 * DAY;
const HOT = "svc-hot";
const TOTAL = 1_000_000;
const ROUNDS = 1000;
const MAX_SEGMENTS = 20;
const ROUND_BUDGET_MS = 10_000;
const MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;

const CONCENTRATED_START = T0 + 30 * DAY;
const CONCENTRATED_TOTAL = 401_000;
const BURST_STARTS: number[] = [];
for (let k = 0; k < 10; k += 1) {
  BURST_STARTS.push(
    k < 5 ? T0 + 200_000_000 + k * 350_000_000 : T0 + 2_700_000_000 + (k - 5) * 500_000_000,
  );
}

/** Numeric mirror key for a trace id: `trace-N` -> N, `churn-N` -> ~N. */
function traceKeyOf(traceId: string): number {
  if (traceId.startsWith("churn-")) return ~Number(traceId.slice(6));
  return Number(traceId.slice(6));
}

/** Columnar mirror of everything ever appended; deletions go through `deleted`. */
interface Mirror {
  readonly timestamps: Float64Array;
  readonly statuses: Int32Array;
  /** Numeric trace key per record: base traces use their id, churn traces ~id. */
  readonly traceKeys: Int32Array;
  readonly deletedTraces: Set<number>;
  count: number;
  live: number;
}

function newMirror(capacity: number): Mirror {
  return {
    timestamps: new Float64Array(capacity),
    statuses: new Int32Array(capacity),
    traceKeys: new Int32Array(capacity),
    deletedTraces: new Set(),
    count: 0,
    live: 0,
  };
}

function mirrorAdd(
  mirror: Mirror,
  timestampMs: number,
  status: number,
  traceKey: number,
): void {
  const slot = mirror.count;
  mirror.count += 1;
  mirror.timestamps[slot] = timestampMs;
  mirror.statuses[slot] = status;
  mirror.traceKeys[slot] = traceKey;
  mirror.live += 1;
}

/** Compacts the live records into fresh columnar arrays for the sweep. */
function mirrorLiveColumns(mirror: Mirror): { timestamps: Float64Array; statuses: Int32Array } {
  const timestamps = new Float64Array(mirror.live);
  const statuses = new Int32Array(mirror.live);
  let n = 0;
  for (let i = 0; i < mirror.count; i += 1) {
    if (mirror.deletedTraces.has(mirror.traceKeys[i] as number)) continue;
    timestamps[n] = mirror.timestamps[i] as number;
    statuses[n] = mirror.statuses[i] as number;
    n += 1;
  }
  return { timestamps, statuses };
}

test("scale: 1M records, 1000 churn rounds under 10s and 768 MiB", () => {
  const rand = mulberry32(20261006);
  const analyzer = new AlertAnalyzer();
  const mirror = newMirror(TOTAL + ROUNDS * 4);
  const churnTraces: string[] = [];
  let nextTrace = 0;
  const newTrace = (churn: boolean): number => {
    const key = nextTrace++;
    if (churn) churnTraces.push(`trace-${key}`);
    return key;
  };

  const loadStart = performance.now();
  const pending: Array<{ ts: number; status: number; traceId: string }> = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    analyzer.addRecords(
      pending.map((p) => ({ timestampMs: p.ts, service: HOT, status: p.status, traceId: p.traceId })),
    );
    pending.length = 0;
  };
  const emit = (ts: number, status: number, traceKey: number): void => {
    const traceId = `trace-${traceKey}`;
    mirrorAdd(mirror, ts, status, traceKey);
    pending.push({ ts, status, traceId });
    if (pending.length >= 20_000) flush();
  };

  // ~401k records concentrated in a single 15-minute window on day 30.
  // Errors are deterministically interleaved (1 per 15 records, 6.67%) so
  // the dense window forms exactly one clean anomalous interval.
  for (let i = 0; i < CONCENTRATED_TOTAL; i += 1) {
    const ts = CONCENTRATED_START + Math.floor((i * 900_000) / CONCENTRATED_TOTAL);
    emit(ts, i % 15 === 0 ? 500 + (i % 97) : 200, newTrace(i % 151 === 0));
  }
  // 10 error bursts away from the concentrated window (5 before, 5 after),
  // each 30 errors per 50 records (60%), deterministically interleaved.
  for (const burstStart of BURST_STARTS) {
    for (let i = 0; i < 50; i += 1) {
      emit(burstStart + i * 1200, i % 5 < 3 ? 503 : 200, newTrace(i % 23 === 0));
    }
  }
  // Remaining records: successes spread across the full 90 days.
  const spread = TOTAL - mirror.count;
  for (let i = 0; i < spread; i += 1) {
    emit(T0 + Math.floor(rand() * SPAN), 200, newTrace(i % 97 === 0));
  }
  flush();
  const loadMs = performance.now() - loadStart;

  const verify = (label: string): void => {
    const { timestamps, statuses } = mirrorLiveColumns(mirror);
    const expected = sweepAnomalyIntervalsFromColumns(
      timestamps,
      statuses,
      mirror.live,
      T0,
      T0 + SPAN,
    );
    const actual = analyzer.queryAnomalyIntervals(HOT, T0, T0 + SPAN);
    deepEqual(actual, expected, `verification failed at ${label}`);
  };
  verify("initial load");

  let maxRss = 0;
  let maxHeap = 0;
  const sampleMemory = (): void => {
    if (global.gc !== undefined) global.gc();
    const usage = process.memoryUsage();
    if (usage.rss > maxRss) maxRss = usage.rss;
    if (usage.heapUsed > maxHeap) maxHeap = usage.heapUsed;
  };
  sampleMemory();

  let nextChurnTrace = 0;
  const roundsStart = performance.now();
  let maxSegments = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    if (rand() < 0.5 && churnTraces.length > 0) {
      // Delete a churn trace (1-2 records) chosen at random.
      const index = Math.floor(rand() * churnTraces.length);
      const traceId = churnTraces.splice(index, 1)[0] as string;
      const removed = analyzer.deleteByTraceId(traceId);
      ok(removed > 0, "churn trace should exist");
      mirror.deletedTraces.add(traceKeyOf(traceId));
      mirror.live -= removed;
    } else {
      // Append 1-3 records with a fresh trace; timestamps may fall anywhere
      // in the 90 days, including old and highly concentrated regions.
      const size = 1 + Math.floor(rand() * 3);
      const traceId = `churn-${nextChurnTrace++}`;
      churnTraces.push(traceId);
      const traceKey = ~(nextChurnTrace - 1);
      const batch = [];
      for (let i = 0; i < size; i += 1) {
        const roll = rand();
        let ts: number;
        let status: number;
        if (roll < 0.6) {
          ts = T0 + Math.floor(rand() * SPAN); // anywhere, incl. old times
          status = 200;
        } else if (roll < 0.85) {
          ts = CONCENTRATED_START + Math.floor(rand() * 900_000); // concentrated
          status = 200;
        } else {
          const burstStart = BURST_STARTS[Math.floor(rand() * BURST_STARTS.length)] as number;
          ts = burstStart + Math.floor(rand() * 60_000); // inside a burst
          status = 500 + Math.floor(rand() * 100);
        }
        mirrorAdd(mirror, ts, status, traceKey);
        batch.push({ timestampMs: ts, service: HOT, status, traceId });
      }
      analyzer.addRecords(batch);
    }

    const segments = analyzer.queryAnomalyIntervals(HOT, T0, T0 + SPAN);
    if (segments.length > maxSegments) maxSegments = segments.length;
    ok(
      segments.length <= MAX_SEGMENTS,
      `round ${round}: ${segments.length} segments exceeds ${MAX_SEGMENTS}`,
    );
    if (round === Math.floor(ROUNDS / 2)) verify("round 500");
    if (round % 50 === 0) sampleMemory();
  }
  const roundsMs = performance.now() - roundsStart;
  sampleMemory();
  verify("final state");

  const toMiB = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `[scale] records=${mirror.live} load=${loadMs.toFixed(0)}ms ` +
      `rounds=${ROUNDS} roundsTime=${roundsMs.toFixed(0)}ms maxSegments=${maxSegments} ` +
      `peakRss=${toMiB(maxRss)}MiB peakHeapUsed=${toMiB(maxHeap)}MiB`,
  );
  ok(
    roundsMs <= ROUND_BUDGET_MS,
    `${ROUNDS} rounds took ${roundsMs.toFixed(0)}ms > ${ROUND_BUDGET_MS}ms`,
  );
  ok(
    maxRss <= MEMORY_BUDGET_BYTES,
    `peak RSS ${toMiB(maxRss)}MiB exceeds 768MiB`,
  );
});
