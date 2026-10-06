import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { AlertAnalyzer, WINDOW_MS } from "../src/analyzer";
import type { RequestRecord } from "../src/types";
import { bruteForceAnomalyIntervals, formatIntervals, mulberry32 } from "./helpers";

interface FuzzConfig {
  readonly seed: number;
  readonly ops: number;
  readonly services: number;
  readonly maxTimestamp: number;
  /** When true, timestamps cluster on a few values to stress same-ms events. */
  readonly clustered: boolean;
}

function runFuzz(config: FuzzConfig): void {
  const rand = mulberry32(config.seed);
  const analyzer = new AlertAnalyzer();
  const mirror: RequestRecord[] = [];
  const liveTraces: string[] = [];
  let nextTrace = 0;

  const randomTimestamp = (): number => {
    if (config.clustered) {
      // Few distinct timestamps, and often exactly one window apart so
      // entries and exits collide in the same millisecond.
      const base = Math.floor(rand() * 8) * 1000;
      const shift = rand() < 0.4 ? WINDOW_MS : 0;
      return base + shift + Math.floor(rand() * 3);
    }
    if (rand() < 0.2 && mirror.length > 0) {
      // Land on (or one window away from) an existing timestamp.
      const other = mirror[Math.floor(rand() * mirror.length)] as RequestRecord;
      const shift = rand() < 0.5 ? 0 : WINDOW_MS;
      return Math.max(0, other.timestampMs - shift + Math.floor(rand() * 5) - 2);
    }
    return Math.floor(rand() * config.maxTimestamp);
  };

  const randomStatus = (): number => {
    const roll = rand();
    if (roll < 0.35) return 500 + Math.floor(rand() * 100); // 5xx error
    if (roll < 0.45) return roll < 0.4 ? 599 : 600; // boundary statuses
    return 200 + Math.floor(rand() * 200); // non-error
  };

  for (let op = 0; op < config.ops; op += 1) {
    if (rand() < 0.3 && liveTraces.length > 0) {
      const traceId = liveTraces[Math.floor(rand() * liveTraces.length)] as string;
      const removed = analyzer.deleteByTraceId(traceId);
      let expected = 0;
      for (let i = mirror.length - 1; i >= 0; i -= 1) {
        if ((mirror[i] as RequestRecord).traceId === traceId) {
          mirror.splice(i, 1);
          expected += 1;
        }
      }
      deepEqual(removed, expected, "deleteByTraceId count");
      liveTraces.splice(liveTraces.indexOf(traceId), 1);
    } else {
      const batch: RequestRecord[] = [];
      const size = 1 + Math.floor(rand() * 6);
      for (let i = 0; i < size; i += 1) {
        const traceId = rand() < 0.6 || liveTraces.length === 0
          ? `trace-${nextTrace++}`
          : (liveTraces[Math.floor(rand() * liveTraces.length)] as string);
        if (!liveTraces.includes(traceId)) liveTraces.push(traceId);
        batch.push({
          timestampMs: randomTimestamp(),
          service: `svc-${Math.floor(rand() * config.services)}`,
          status: randomStatus(),
          traceId,
        });
      }
      mirror.push(...batch);
      analyzer.addRecords(batch);
    }

    const service = `svc-${Math.floor(rand() * config.services)}`;
    const rangeRoll = rand();
    let startMs = 0;
    let endMs = config.maxTimestamp + WINDOW_MS + 10;
    if (rangeRoll < 0.4) {
      startMs = Math.floor(rand() * (config.maxTimestamp + WINDOW_MS));
      endMs = startMs + Math.floor(rand() * (config.maxTimestamp / 4 + 10));
    } else if (rangeRoll < 0.45) {
      startMs = 500;
      endMs = 500; // empty range
    }
    const actual = analyzer.queryAnomalyIntervals(service, startMs, endMs);
    const expected = bruteForceAnomalyIntervals(mirror, service, startMs, endMs);
    deepEqual(
      actual,
      expected,
      `op ${op}: ${service} [${startMs}, ${endMs}) got ${formatIntervals(actual)} ` +
        `want ${formatIntervals(expected)}`,
    );
  }
}

test("fuzz: spread timestamps with random adds, deletes and queries", () => {
  runFuzz({ seed: 42, ops: 250, services: 4, maxTimestamp: 3_000_000, clustered: false });
  runFuzz({ seed: 1337, ops: 250, services: 2, maxTimestamp: 5_000_000, clustered: false });
});

test("fuzz: clustered timestamps with colliding window entries and exits", () => {
  runFuzz({ seed: 7, ops: 250, services: 3, maxTimestamp: 10_000, clustered: true });
  runFuzz({ seed: 2026, ops: 250, services: 1, maxTimestamp: 10_000, clustered: true });
});
