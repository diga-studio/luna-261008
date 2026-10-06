import { performance } from "node:perf_hooks";
import {
  LeadPulse,
  DAY_MS,
  EVENT_TYPES,
  type BehaviorEvent,
} from "../src/index.js";

const LEAD_COUNT = 200;
const HOT_LEAD_EVENTS = 300_000;
const TOTAL_EVENTS = 500_000;
const WRITES = 10_000;
const QUERIES = 20_000;
const WEIGHT_CHANGES = 100;
const HISTORY_SPAN_MS = 365 * DAY_MS;
const NOW = 1_760_000_000_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function memorySnapshot() {
  const { heapUsed, rss } = process.memoryUsage();
  return { heapUsed, rss };
}

function main(): void {
  const rand = mulberry32(20261006);
  const leadIds: string[] = [];
  for (let i = 0; i < LEAD_COUNT; i++) leadIds.push(`lead-${i}`);

  // ---- generate test input (excluded from component memory accounting) ----
  const events: BehaviorEvent[] = new Array(TOTAL_EVENTS);
  for (let i = 0; i < TOTAL_EVENTS; i++) {
    const leadId =
      i < HOT_LEAD_EVENTS
        ? leadIds[0]!
        : leadIds[1 + Math.floor(rand() * (LEAD_COUNT - 1))]!;
    const type = EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!;
    const occurredAt = NOW - Math.floor(rand() * HISTORY_SPAN_MS);
    events[i] = { id: `evt-${i}`, leadId, type, occurredAt };
  }
  // shuffle to simulate arbitrary out-of-order arrival
  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = events[i]!;
    events[i] = events[j]!;
    events[j] = tmp;
  }

  // pre-generate mixed workload operations
  const workloadEvents: BehaviorEvent[] = new Array(WRITES);
  for (let i = 0; i < WRITES; i++) {
    workloadEvents[i] = {
      id: `live-${i}`,
      leadId: leadIds[Math.floor(rand() * LEAD_COUNT)]!,
      type: EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!,
      occurredAt: NOW - Math.floor(rand() * HISTORY_SPAN_MS),
    };
  }
  const queryPlan: Array<{ leadId: string; queryAt: number }> = [];
  for (let i = 0; i < QUERIES; i++) {
    queryPlan.push({
      leadId: leadIds[Math.floor(rand() * LEAD_COUNT)]!,
      queryAt: NOW - Math.floor(rand() * HISTORY_SPAN_MS),
    });
  }
  const weightPlan: Array<Record<string, number>> = [];
  for (let i = 0; i < WEIGHT_CHANGES; i++) {
    weightPlan.push({
      [EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!]: Math.floor(
        rand() * 101,
      ),
    });
  }

  globalThis.gc!();
  const baseline = memorySnapshot();

  // ---- initial load ----
  const lp = new LeadPulse();
  for (const id of leadIds) {
    lp.registerLead(id, 1 + Math.floor(rand() * 5000));
  }
  const loadStart = performance.now();
  let accepted = 0;
  for (const e of events) {
    if (lp.ingestEvent(e)) accepted++;
  }
  // ~1% duplicate redeliveries
  for (let i = 0; i < TOTAL_EVENTS / 100; i++) {
    lp.ingestEvent(events[Math.floor(rand() * TOTAL_EVENTS)]!);
  }
  const loadMs = performance.now() - loadStart;

  globalThis.gc!();
  const afterLoad = memorySnapshot();

  // ---- mixed workload: 10k writes + 20k queries + 100 weight changes ----
  const workloadStart = performance.now();
  let queryCursor = 0;
  let weightCursor = 0;
  let checksum = 0;
  for (let i = 0; i < WRITES; i++) {
    lp.ingestEvent(workloadEvents[i]!);
    for (let q = 0; q < QUERIES / WRITES; q++) {
      const plan = queryPlan[queryCursor++]!;
      checksum += lp.scoreAt(plan.leadId, plan.queryAt).score;
    }
    if (i % (WRITES / WEIGHT_CHANGES) === WRITES / WEIGHT_CHANGES - 1) {
      lp.setWeights(weightPlan[weightCursor++]!);
    }
  }
  const workloadMs = performance.now() - workloadStart;

  globalThis.gc!();
  const afterWorkload = memorySnapshot();

  console.log(`accepted events:        ${accepted} / ${TOTAL_EVENTS}`);
  console.log(`initial load:           ${loadMs.toFixed(0)} ms`);
  console.log(
    `mixed workload:         ${workloadMs.toFixed(0)} ms ` +
      `(${WRITES} writes + ${QUERIES} queries + ${WEIGHT_CHANGES} weight changes)`,
  );
  console.log(`workload budget 5s:     ${workloadMs <= 5000 ? "PASS" : "FAIL"}`);
  console.log(
    `component heap (load):  ${mb(afterLoad.heapUsed - baseline.heapUsed)} MiB ` +
      `(rss delta ${mb(afterLoad.rss - baseline.rss)} MiB)`,
  );
  console.log(
    `component heap (final): ${mb(afterWorkload.heapUsed - baseline.heapUsed)} MiB ` +
      `(rss delta ${mb(afterWorkload.rss - baseline.rss)} MiB)`,
  );
  console.log(
    `memory budget 256 MiB:  ${
      afterWorkload.heapUsed - baseline.heapUsed <= 256 * 1024 * 1024
        ? "PASS"
        : "FAIL"
    }`,
  );
  console.log(`query checksum:         ${checksum.toFixed(2)}`);
}

main();
