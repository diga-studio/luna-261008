import assert from "node:assert/strict";
import test from "node:test";
import { LogAlertAnalyzer, WINDOW_MS, type AnomalyInterval, type RequestRecord } from "../src/index.js";

const DAY_MS = 24 * 3600 * 1000;
const SPAN_MS = 90 * DAY_MS;
const T0 = 1_700_000_000_000;
const SERVICE_COUNT = 50;
const HOT_SERVICE = 0;
const CLUSTER_START = T0 + 3_000_000_000;
const ROUNDS = 1000;
const ROUND_BUDGET_MS = 10_000;
const MEMORY_BUDGET_BYTES = 768 * 1024 * 1024;
const MAX_RECORDS = 1_100_000;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("scale: 1M records, 1000 rounds of mixed ops under 10s and 768MiB", { timeout: 300_000 }, () => {
  const rand = mulberry32(20261008);
  const analyzer = new LogAlertAnalyzer();

  // Compact live-record store used for independent recounts. The library
  // gets plain record objects (transient); the test keeps only flat arrays.
  const recTs = new Float64Array(MAX_RECORDS);
  const recSvc = new Uint8Array(MAX_RECORDS);
  const recStatus = new Uint16Array(MAX_RECORDS);
  const recAlive = new Uint8Array(MAX_RECORDS);
  let recCount = 0;
  const traceIds: string[] = [];
  const traceRecs: number[][] = [];
  const liveTracePool: number[] = [];

  const svcNames = Array.from({ length: SERVICE_COUNT }, (_, i) => `svc-${i}`);
  const svcIndex = new Map<string, number>(svcNames.map((name, i) => [name, i]));
  const svcName = (i: number) => svcNames[i]!;

  const addRecords = (batch: RequestRecord[], traces: number[]) => {
    analyzer.append(batch);
    for (let i = 0; i < batch.length; i++) {
      const idx = recCount++;
      recTs[idx] = batch[i]!.timestampMs;
      recSvc[idx] = svcIndex.get(batch[i]!.service)!;
      recStatus[idx] = batch[i]!.statusCode;
      recAlive[idx] = 1;
      traceRecs[traces[i]!]!.push(idx);
    }
  };
  const newTrace = (name: string, pool: boolean) => {
    const idx = traceIds.length;
    traceIds.push(name);
    traceRecs.push([]);
    if (pool) liveTracePool.push(idx);
    return idx;
  };

  const deleteTrace = (traceIdx: number) => {
    analyzer.deleteByTraceId(traceIds[traceIdx]!);
    for (const recIdx of traceRecs[traceIdx]!) recAlive[recIdx] = 0;
    const poolIdx = liveTracePool.indexOf(traceIdx);
    if (poolIdx >= 0) {
      liveTracePool[poolIdx] = liveTracePool[liveTracePool.length - 1]!;
      liveTracePool.pop();
    }
  };

  /** Independent recount over the flat store: sweep window-count events. */
  const referenceFor = (service: number, from: number, to: number): AnomalyInterval[] => {
    const deltas = new Map<number, number[]>();
    for (let i = 0; i < recCount; i++) {
      if (recAlive[i] === 0 || recSvc[i] !== service) continue;
      const err = recStatus[i]! >= 500 && recStatus[i]! <= 599 ? 1 : 0;
      const ts = recTs[i]!;
      for (const [t, dn, de] of [
        [ts, 1, err],
        [ts + WINDOW_MS, -1, -err],
      ] as const) {
        let slot = deltas.get(t);
        if (slot === undefined) {
          slot = [0, 0];
          deltas.set(t, slot);
        }
        slot[0]! += dn;
        slot[1]! += de;
      }
    }
    const times = [...deltas.keys()].sort((a, b) => a - b);
    const out: AnomalyInterval[] = [];
    let total = 0;
    let errors = 0;
    for (let i = 0; i < times.length; i++) {
      const slot = deltas.get(times[i]!)!;
      total += slot[0]!;
      errors += slot[1]!;
      if (errors * 20 > total) {
        const segEnd = i + 1 < times.length ? times[i + 1]! : Infinity;
        const s = Math.max(times[i]!, from);
        const e = Math.min(segEnd, to);
        if (s < e) {
          const last = out[out.length - 1];
          if (last !== undefined && last.endMs === s) last.endMs = e;
          else out.push({ startMs: s, endMs: e });
        }
      }
    }
    return out;
  };

  // ---- Initial load: ~1M records ----------------------------------------
  let pending: RequestRecord[] = [];
  let pendingTraces: number[] = [];
  const flush = () => {
    if (pending.length > 0) {
      addRecords(pending, pendingTraces);
      pending = [];
      pendingTraces = [];
    }
  };
  const stage = (ts: number, svc: number, status: number, trace: number) => {
    pending.push({ timestampMs: ts, service: svcName(svc), statusCode: status, traceId: traceIds[trace]! });
    pendingTraces.push(trace);
    if (pending.length >= 500_000) flush();
  };
  // 300k successes concentrated into one 15 minute window of svc-0.
  for (let i = 0; i < 300_000; i++) {
    const trace = i % 3 === 0 ? newTrace(`c-${i / 3}`, true) : traceIds.length - 1;
    stage(CLUSTER_START + ((i * 7) % WINDOW_MS), HOT_SERVICE, 200, trace);
  }
  // 700k successes spread over 90 days across the other 49 services.
  for (let i = 0; i < 700_000; i++) {
    const trace = i % 4 === 0 ? newTrace(`s-${i / 4}`, true) : traceIds.length - 1;
    stage(T0 + Math.floor(rand() * SPAN_MS), 1 + (i % (SERVICE_COUNT - 1)), 200, trace);
  }
  // 12 incidents (30 errors + 30 successes over 10 minutes) in distinct
  // services, each producing exactly one anomalous interval.
  const incidentServices: number[] = [];
  for (let k = 0; k < 12; k++) {
    const service = 1 + k * 4;
    incidentServices.push(service);
    const start = T0 + 500_000_000 + k * 600_000_000;
    for (let j = 0; j < 30; j++) {
      stage(start + j * 20_000, service, 503, newTrace(`inc-${k}-e${j}`, false));
      stage(start + j * 20_000 + 10_000, service, 200, newTrace(`inc-${k}-o${j}`, false));
    }
  }
  flush();
  const incidentTraceBase = (k: number, j: number, kind: "e" | "o") =>
    traceIds.indexOf(`inc-${k}-${kind}${j}`);

  const loadCheck = (service: number) => {
    assert.deepEqual(
      analyzer.queryAnomalyIntervals(svcName(service), T0, T0 + SPAN_MS),
      referenceFor(service, T0, T0 + SPAN_MS),
      `post-load svc-${service}`,
    );
  };
  loadCheck(HOT_SERVICE);
  loadCheck(incidentServices[0]!);
  loadCheck(incidentServices[11]!);
  assert.equal(analyzer.queryAnomalyIntervals(svcName(incidentServices[0]!), T0, T0 + SPAN_MS).length, 1);

  let peakRss = process.memoryUsage().rss;
  const sampleMem = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };
  sampleMem();

  // ---- 1000 rounds of small mutations + full-range queries ---------------
  const queryServices = [HOT_SERVICE, ...incidentServices, 2, 3];
  let checked = 0;
  const started = performance.now();
  for (let round = 0; round < ROUNDS; round++) {
    if (round >= 900 && round < 906) {
      // Wipe incident 3 (60 single-record traces, 10 per round): its
      // anomalous interval must disappear from recounts.
      for (let j = (round - 900) * 5; j < (round - 900) * 5 + 5; j++) {
        deleteTrace(incidentTraceBase(3, j, "e"));
        deleteTrace(incidentTraceBase(3, j, "o"));
      }
    } else if (liveTracePool.length > 0 && rand() < 0.5) {
      const n = 1 + Math.floor(rand() * 10);
      for (let i = 0; i < n; i++) {
        deleteTrace(liveTracePool[Math.floor(rand() * liveTracePool.length)]!);
      }
    } else {
      const n = 1 + Math.floor(rand() * 10);
      const records: RequestRecord[] = [];
      const traces: number[] = [];
      for (let i = 0; i < n; i++) {
        const pick = rand();
        // Old timestamps, the dense cluster, and anywhere are all exercised.
        const ts =
          pick < 0.4
            ? T0 + Math.floor(rand() * (SPAN_MS / 10))
            : pick < 0.7
              ? CLUSTER_START + Math.floor(rand() * WINDOW_MS)
              : T0 + Math.floor(rand() * SPAN_MS);
        const svc = rand() < 0.5 ? HOT_SERVICE : Math.floor(rand() * SERVICE_COUNT);
        const trace = newTrace(`r-${round}-${i}`, true);
        records.push({
          timestampMs: ts,
          service: svcName(svc),
          statusCode: 200,
          traceId: traceIds[trace]!,
        });
        traces.push(trace);
      }
      addRecords(records, traces);
    }
    const service = queryServices[round % queryServices.length]!;
    const got = analyzer.queryAnomalyIntervals(svcName(service), T0, T0 + SPAN_MS);
    assert.ok(got.length <= 20, `round ${round}: ${got.length} segments`);
    if (round % 100 === 0 || (round >= 900 && round < 906)) {
      assert.deepEqual(got, referenceFor(service, T0, T0 + SPAN_MS), `round ${round} svc-${service}`);
      checked++;
    }
    if (round % 100 === 0) sampleMem();
  }
  const elapsedMs = performance.now() - started;
  sampleMem();

  console.log(
    `scale: ${ROUNDS} rounds in ${elapsedMs.toFixed(0)}ms ` +
      `(budget ${ROUND_BUDGET_MS}ms), peak RSS ${(peakRss / 1024 / 1024).toFixed(0)} MiB ` +
      `(budget 768 MiB), ${checked} recount checks, ${recCount} records`,
  );
  assert.ok(elapsedMs < ROUND_BUDGET_MS, `rounds took ${elapsedMs}ms`);
  assert.ok(peakRss < MEMORY_BUDGET_BYTES, `peak RSS ${peakRss}`);
});
