import assert from "node:assert/strict";
import test from "node:test";
import { LogAlertAnalyzer, WINDOW_MS, type RequestRecord } from "../src/index.js";
import { referenceAnomalyIntervals } from "./reference.js";

const W = WINDOW_MS;

function rec(
  timestampMs: number,
  service: string,
  statusCode: number,
  traceId: string,
): RequestRecord {
  return { timestampMs, service, statusCode, traceId };
}

test("1ms anomaly and exactly-5% boundary", () => {
  const a = new LogAlertAnalyzer();
  const records: RequestRecord[] = [rec(1_000_000, "svc", 500, "e1")];
  for (let i = 0; i < 19; i++) records.push(rec(1_000_001, "svc", 200, `s${i}`));
  a.append(records);
  // Only [1000000, 1000001) has 1/1 = 100% errors; afterwards 1/20 = exactly
  // 5%, which is normal.
  assert.deepEqual(a.queryAnomalyIntervals("svc", 0, 2_000_000), [
    { startMs: 1_000_000, endMs: 1_000_001 },
  ]);
});

test("empty window and empty service are normal", () => {
  const a = new LogAlertAnalyzer();
  assert.deepEqual(a.queryAnomalyIntervals("missing", 0, 1_000_000), []);
  a.append([rec(5_000_000, "svc", 500, "e1")]);
  assert.deepEqual(a.queryAnomalyIntervals("svc", 0, 100), []);
  assert.deepEqual(a.queryAnomalyIntervals("svc", 5_000_000 + W + 1, 9_000_000), []);
  assert.deepEqual(a.queryAnomalyIntervals("svc", 100, 100), []);
});

test("enter and leave at the same millisecond decide jointly", () => {
  const a = new LogAlertAnalyzer();
  const records: RequestRecord[] = [rec(100_000, "svc", 500, "old-err")];
  for (let i = 0; i < 19; i++) records.push(rec(100_000, "svc", 200, `old-ok${i}`));
  // All 20 leave at 100_000 + W; exactly then a new error enters.
  records.push(rec(100_000 + W, "svc", 503, "new-err"));
  a.append(records);
  // 1/20 = exactly 5% before, so the only anomaly starts when the new error
  // enters and the old requests leave, and lasts until the new error leaves.
  assert.deepEqual(a.queryAnomalyIntervals("svc", 0, 3_000_000), [
    { startMs: 100_000 + W, endMs: 100_000 + 2 * W },
  ]);
});

test("query boundary clipping on both sides", () => {
  const a = new LogAlertAnalyzer();
  a.append([rec(1_000_000, "svc", 500, "e1")]);
  const full = [{ startMs: 1_000_000, endMs: 1_000_000 + W }];
  assert.deepEqual(a.queryAnomalyIntervals("svc", 0, 10_000_000), full);
  assert.deepEqual(a.queryAnomalyIntervals("svc", 500_000, 1_500_000), [
    { startMs: 1_000_000, endMs: 1_500_000 },
  ]);
  assert.deepEqual(a.queryAnomalyIntervals("svc", 1_500_000, 2_500_000), [
    { startMs: 1_500_000, endMs: 1_000_000 + W },
  ]);
  // Ranges touching the anomaly exactly at an edge produce nothing.
  assert.deepEqual(a.queryAnomalyIntervals("svc", 0, 1_000_000), []);
  assert.deepEqual(a.queryAnomalyIntervals("svc", 1_000_000 + W, 3_000_000), []);
  // Clipping never yields zero-length intervals.
  for (const iv of a.queryAnomalyIntervals("svc", 999_999, 1_000_001)) {
    assert.ok(iv.endMs > iv.startMs);
  }
});

test("adjacent anomalous segments merge into one interval", () => {
  const a = new LogAlertAnalyzer();
  a.append([
    rec(1_000, "svc", 500, "e1"),
    rec(1_001, "svc", 502, "e2"),
    rec(1_002, "svc", 599, "e3"),
  ]);
  const out = a.queryAnomalyIntervals("svc", 0, 2_000_000);
  assert.deepEqual(out, [{ startMs: 1_000, endMs: 1_002 + W }]);
});

test("records before the query range still count into its window", () => {
  const a = new LogAlertAnalyzer();
  a.append([rec(500_000, "svc", 500, "e1")]);
  assert.deepEqual(a.queryAnomalyIntervals("svc", 1_000_000, 1_200_000), [
    { startMs: 1_000_000, endMs: 1_200_000 },
  ]);
});

test("late arrivals and cross-service trace deletion revise history", () => {
  const a = new LogAlertAnalyzer();
  const live: RequestRecord[] = [];
  const apply = (records: RequestRecord[]) => {
    live.push(...records);
    a.append(records);
  };
  const removeTrace = (traceId: string) => {
    const removed = a.deleteByTraceId(traceId);
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i]!.traceId === traceId) live.splice(i, 1);
    }
    return removed;
  };
  const check = (service: string) => {
    assert.deepEqual(
      a.queryAnomalyIntervals(service, 0, 100_000_000),
      referenceAnomalyIntervals(live, service, 0, 100_000_000),
    );
  };

  // 2 errors + 18 successes at the same instant: 10% error rate, anomalous.
  const burst: RequestRecord[] = [
    rec(10_000_000, "svcA", 500, "err-1"),
    rec(10_000_000, "svcA", 502, "err-2"),
  ];
  for (let i = 0; i < 18; i++) burst.push(rec(10_000_000, "svcA", 200, `ok-${i}`));
  apply(burst);
  assert.equal(a.queryAnomalyIntervals("svcA", 0, 100_000_000).length, 1);
  check("svcA");

  // 20 late successes with old timestamps push the rate to exactly 5%.
  const late: RequestRecord[] = [];
  for (let i = 0; i < 20; i++) late.push(rec(10_000_000, "svcA", 200, `late-${i}`));
  apply(late);
  assert.deepEqual(a.queryAnomalyIntervals("svcA", 0, 100_000_000), []);
  check("svcA");

  // Deleting one late success by trace makes it 2/39 > 5% again.
  removeTrace("late-0");
  assert.equal(a.queryAnomalyIntervals("svcA", 0, 100_000_000).length, 1);
  check("svcA");

  // A trace spanning two services; deleting it revises both.
  apply([
    rec(20_000_000, "svcA", 500, "xtrace"),
    rec(20_000_000, "svcB", 500, "xtrace"),
    rec(20_000_000, "svcB", 200, "xtrace"),
  ]);
  check("svcA");
  check("svcB");
  assert.equal(removeTrace("xtrace"), 3);
  check("svcA");
  check("svcB");
  assert.deepEqual(a.queryAnomalyIntervals("svcB", 0, 100_000_000), []);
  assert.equal(a.deleteByTraceId("xtrace"), 0);
  assert.equal(a.deleteByTraceId("never-seen"), 0);
});

test("randomized fuzz matches independent recount after every round", () => {
  let seed = 0xC0FFEE;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const services = ["s0", "s1", "s2", "s3", "s4"];
  const a = new LogAlertAnalyzer();
  const live: RequestRecord[] = [];
  const liveTraces: string[] = [];
  let traceSeq = 0;
  for (let round = 0; round < 400; round++) {
    if (liveTraces.length > 0 && rand() < 0.35) {
      const idx = Math.floor(rand() * liveTraces.length);
      const traceId = liveTraces.splice(idx, 1)[0]!;
      a.deleteByTraceId(traceId);
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i]!.traceId === traceId) live.splice(i, 1);
      }
    } else {
      const batch: RequestRecord[] = [];
      const n = 1 + Math.floor(rand() * 8);
      const traceId = `t${traceSeq++}`;
      for (let i = 0; i < n; i++) {
        batch.push(
          rec(
            Math.floor(rand() * 10_000_000),
            services[Math.floor(rand() * services.length)]!,
            rand() < 0.08 ? 500 + Math.floor(rand() * 100) : 200,
            rand() < 0.7 ? traceId : `t${traceSeq++}`,
          ),
        );
      }
      liveTraces.push(traceId);
      live.push(...batch);
      a.append(batch);
    }
    for (let q = 0; q < 2; q++) {
      const service = services[Math.floor(rand() * services.length)]!;
      const from = Math.floor(rand() * 12_000_000);
      const to = from + Math.floor(rand() * 4_000_000);
      assert.deepEqual(
        a.queryAnomalyIntervals(service, from, to),
        referenceAnomalyIntervals(live, service, from, to),
        `round ${round} service ${service} [${from}, ${to})`,
      );
    }
  }
});

test("dense single-service fuzz exercises block splits and merges", () => {
  let seed = 1234567;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = new LogAlertAnalyzer();
  const live: RequestRecord[] = [];
  const liveTraces: string[] = [];
  let traceSeq = 0;
  // ~8000 events in one service: forces the event store into several blocks.
  for (let round = 0; round < 800; round++) {
    if (liveTraces.length > 0 && rand() < 0.4) {
      const idx = Math.floor(rand() * liveTraces.length);
      const traceId = liveTraces.splice(idx, 1)[0]!;
      a.deleteByTraceId(traceId);
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i]!.traceId === traceId) live.splice(i, 1);
      }
    } else {
      const batch: RequestRecord[] = [];
      const n = 1 + Math.floor(rand() * 10);
      for (let i = 0; i < n; i++) {
        const traceId = `t${traceSeq++}`;
        liveTraces.push(traceId);
        batch.push(
          rec(
            Math.floor(rand() * 500_000),
            "svc",
            rand() < 0.06 ? 500 + Math.floor(rand() * 100) : 200,
            traceId,
          ),
        );
      }
      live.push(...batch);
      a.append(batch);
    }
    const from = Math.floor(rand() * 600_000);
    const to = from + Math.floor(rand() * 300_000);
    assert.deepEqual(
      a.queryAnomalyIntervals("svc", from, to),
      referenceAnomalyIntervals(live, "svc", from, to),
      `round ${round} [${from}, ${to})`,
    );
  }
});
