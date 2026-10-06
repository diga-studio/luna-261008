import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { AlertAnalyzer, WINDOW_MS } from "../src/analyzer";
import type { AnomalyInterval, RequestRecord } from "../src/types";
import { bruteForceAnomalyIntervals, formatIntervals } from "./helpers";

function rec(timestampMs: number, status: number, traceId: string, service = "svc"): RequestRecord {
  return { timestampMs, service, status, traceId };
}

function assertQuery(
  analyzer: AlertAnalyzer,
  records: readonly RequestRecord[],
  service: string,
  startMs: number,
  endMs: number,
  expected: AnomalyInterval[],
): void {
  const actual = analyzer.queryAnomalyIntervals(service, startMs, endMs);
  deepEqual(
    actual,
    expected,
    `query ${service} [${startMs}, ${endMs}): got ${formatIntervals(actual)}`,
  );
  // Cross-check against an independent recount from the raw records.
  deepEqual(
    actual,
    bruteForceAnomalyIntervals(records, service, startMs, endMs),
    `brute-force mismatch for ${service} [${startMs}, ${endMs})`,
  );
}

test("exactly 5% error rate and empty windows are normal", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [rec(1000, 500, "e1")];
  for (let i = 0; i < 19; i += 1) records.push(rec(1000, 200, `s${i}`));
  analyzer.addRecords(records);
  assertQuery(analyzer, records, "svc", 0, 2_000_000, []);
  assertQuery(analyzer, records, "unknown-service", 0, 2_000_000, []);
  // 1 error out of 19 total is 5.26% and is anomalous.
  const analyzer2 = new AlertAnalyzer();
  const records2: RequestRecord[] = [rec(1000, 503, "e1")];
  for (let i = 0; i < 18; i += 1) records2.push(rec(1000, 200, `s${i}`));
  analyzer2.addRecords(records2);
  assertQuery(analyzer2, records2, "svc", 0, 2_000_000, [
    { startMs: 1000, endMs: 1000 + WINDOW_MS },
  ]);
});

test("an anomaly lasting a single millisecond is reported", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [rec(1000, 500, "e1")];
  for (let i = 0; i < 19; i += 1) records.push(rec(1001, 200, `s${i}`));
  analyzer.addRecords(records);
  // At t=1000 the window holds only the error (100%); at t=1001 it holds
  // 20 requests with exactly 5% errors, which is normal.
  assertQuery(analyzer, records, "svc", 0, 2_000_000, [{ startMs: 1000, endMs: 1001 }]);
});

test("entries and exits in the same millisecond jointly decide the result", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [
    rec(1000, 500, "e1"), // leaves the window exactly at 1000 + WINDOW_MS
    rec(1000 + WINDOW_MS, 500, "e2"), // enters at the same instant
  ];
  for (let i = 0; i < 19; i += 1) records.push(rec(1000 + WINDOW_MS, 200, `s${i}`));
  analyzer.addRecords(records);
  // Up to 901000 the window holds only e1 (anomalous). At t=901000 e1 has
  // left and the window holds e2 plus 19 successes: exactly 5%, normal.
  assertQuery(analyzer, records, "svc", 0, 3_000_000, [
    { startMs: 1000, endMs: 1000 + WINDOW_MS },
  ]);
});

test("query ranges are half-open and clip anomalous intervals", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [rec(1000, 500, "e1")];
  analyzer.addRecords(records);
  const full = [{ startMs: 1000, endMs: 1000 + WINDOW_MS }];
  assertQuery(analyzer, records, "svc", 0, 2_000_000, full);
  assertQuery(analyzer, records, "svc", 0, 500, []);
  assertQuery(analyzer, records, "svc", 0, 1000, []); // ends where anomaly starts
  assertQuery(analyzer, records, "svc", 1000 + WINDOW_MS, 1000 + WINDOW_MS + 1, []);
  assertQuery(analyzer, records, "svc", 500, 1500, [{ startMs: 1000, endMs: 1500 }]);
  assertQuery(analyzer, records, "svc", 1500, 2000, [{ startMs: 1500, endMs: 2000 }]);
  assertQuery(analyzer, records, "svc", 1001, 900_999, [{ startMs: 1001, endMs: 900_999 }]);
  assertQuery(analyzer, records, "svc", 1000, 1000 + WINDOW_MS, full);
  assertQuery(analyzer, records, "svc", 2000, 1000, []); // empty range
});

test("adjacent anomalous runs merge, disjoint runs stay separate", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [
    rec(1000, 500, "e1"),
    rec(1001, 500, "e2"),
    rec(5000, 500, "e3"),
  ];
  for (let i = 0; i < 38; i += 1) records.push(rec(1002, 200, `sa${i}`));
  for (let i = 0; i < 19; i += 1) records.push(rec(5001, 200, `sb${i}`));
  analyzer.addRecords(records);
  // [1000,1002): 1/1 then 2/2 anomalous; at 1002 exactly 5% (normal).
  // [5000,5001): 1/1 anomalous; at 5001 exactly 5% (normal).
  // The first two runs are contiguous and must merge into one interval.
  assertQuery(analyzer, records, "svc", 0, 2_000_000, [
    { startMs: 1000, endMs: 1002 },
    { startMs: 5000, endMs: 5001 },
  ]);
});

test("late success shrinks an old alert; cross-service trace delete restores it", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [];
  const add = (batch: RequestRecord[]) => {
    records.push(...batch);
    analyzer.addRecords(batch);
  };

  add([rec(10_000, 500, "err-a", "svcA")]);
  assertQuery(analyzer, records, "svcA", 0, 2_000_000, [
    { startMs: 10_000, endMs: 10_000 + WINDOW_MS },
  ]);

  // 19 successes arrive late with earlier timestamps on the same trace,
  // plus one request on another service sharing the trace.
  const late: RequestRecord[] = [];
  for (let i = 0; i < 19; i += 1) late.push(rec(9_500, 200, "late-trace", "svcA"));
  late.push(rec(10_000, 500, "late-trace", "svcB"));
  add(late);

  // svcA: while the successes are in the window the rate is exactly 5%;
  // after they leave (at 909500) only the error remains until 910000.
  assertQuery(analyzer, records, "svcA", 0, 2_000_000, [
    { startMs: 909_500, endMs: 910_000 },
  ]);
  assertQuery(analyzer, records, "svcB", 0, 2_000_000, [
    { startMs: 10_000, endMs: 910_000 },
  ]);

  // Deleting the trace removes requests from both services at once.
  equal(analyzer.deleteByTraceId("late-trace"), 20);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if ((records[i] as RequestRecord).traceId === "late-trace") records.splice(i, 1);
  }
  assertQuery(analyzer, records, "svcA", 0, 2_000_000, [
    { startMs: 10_000, endMs: 910_000 },
  ]);
  assertQuery(analyzer, records, "svcB", 0, 2_000_000, []);
  equal(analyzer.deleteByTraceId("late-trace"), 0); // already gone
});

test("late records can split a historical anomalous interval", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [];
  const add = (batch: RequestRecord[]) => {
    records.push(...batch);
    analyzer.addRecords(batch);
  };

  add([rec(1000, 500, "e1"), rec(2000, 500, "e2")]);
  assertQuery(analyzer, records, "svc", 0, 2_000_000, [
    { startMs: 1000, endMs: 2000 + WINDOW_MS },
  ]);

  // 38 late successes at t=1500 make the rate exactly 5% while both errors
  // and the successes share a window, splitting the anomaly in two.
  const late: RequestRecord[] = [];
  for (let i = 0; i < 38; i += 1) late.push(rec(1500, 200, `late-${i}`));
  add(late);
  assertQuery(analyzer, records, "svc", 0, 2_000_000, [
    { startMs: 1000, endMs: 1500 },
    { startMs: 1500 + WINDOW_MS, endMs: 2000 + WINDOW_MS },
  ]);
});

test("records of other services never affect a service's windows", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [rec(1000, 500, "shared-trace", "svcA")];
  for (let i = 0; i < 19; i += 1) records.push(rec(1000, 200, "shared-trace", "svcB"));
  analyzer.addRecords(records);
  assertQuery(analyzer, records, "svcA", 0, 2_000_000, [
    { startMs: 1000, endMs: 1000 + WINDOW_MS },
  ]);
  assertQuery(analyzer, records, "svcB", 0, 2_000_000, []);
});

test("out-of-order and duplicate-timestamp appends behave like one batch", () => {
  const analyzer = new AlertAnalyzer();
  const records: RequestRecord[] = [];
  const batch: RequestRecord[] = [rec(5000, 500, "e1")];
  for (let i = 0; i < 19; i += 1) batch.push(rec(5000, 200, `s${i}`));
  // Append one record at a time in reverse order.
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    const single = [batch[i] as RequestRecord];
    records.push(...single);
    analyzer.addRecords(single);
  }
  // Exactly 5% at t=5000: normal everywhere.
  assertQuery(analyzer, records, "svc", 0, 2_000_000, []);
  equal(analyzer.recordCount, 20);
});

test("invalid records are rejected", () => {
  const analyzer = new AlertAnalyzer();
  const bad: unknown[] = [
    { timestampMs: Number.NaN, service: "s", status: 200, traceId: "t" },
    { timestampMs: 1, service: "", status: 200, traceId: "t" },
    { timestampMs: 1, service: "s", status: 99, traceId: "t" },
    { timestampMs: 1, service: "s", status: 200, traceId: "" },
  ];
  for (const record of bad) {
    let threw = false;
    try {
      analyzer.addRecords([record as RequestRecord]);
    } catch {
      threw = true;
    }
    equal(threw, true, `expected rejection of ${JSON.stringify(record)}`);
  }
  equal(analyzer.recordCount, 0);
});
