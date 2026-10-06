import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeartbeatRanker, HOLD_MS, METRICS, WINDOW_HOURS } from "../src/index.js";
import type { Metric, RankEntry, WindowHours } from "../src/index.js";
import { ReferenceRanker } from "../src/reference.js";

const HOUR_MS = 3_600_000;
const T0 = 1_700_000_000_000; // fixed UTC-ms epoch for determinism

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

interface RawBeat {
  nodeId: string;
  timestampMs: number;
  cpu: number;
  memory: number;
  disk: number;
}

function assertSameRanking(actual: RankEntry[], expected: RankEntry[]): void {
  assert.equal(actual.length, expected.length, "ranking length differs");
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].nodeId, expected[i].nodeId, `rank ${i} nodeId`);
    assert.equal(actual[i].integral, expected[i].integral, `rank ${i} integral`);
    assert.equal(
      actual[i].coverageMs,
      expected[i].coverageMs,
      `rank ${i} coverageMs`,
    );
  }
}

function compareAll(
  actual: HeartbeatRanker,
  expected: ReferenceRanker,
  context: string,
): void {
  for (const metric of METRICS) {
    for (const windowHours of WINDOW_HOURS) {
      try {
        assertSameRanking(actual.top(windowHours, metric), expected.top(windowHours, metric));
      } catch (err) {
        throw new Error(
          `${context}: mismatch for metric=${metric} window=${windowHours}h\n${err}`,
        );
      }
    }
  }
}

describe("deterministic shuffled ingestion matches full-history reference", () => {
  it("long silences, late backfills, big clock jumps", () => {
    const rand = mulberry32(0xc0ffee);
    const nodes = ["alpha", "bravo", "charlie", "delta", "echo"];
    const beats: RawBeat[] = [];
    const used = new Map<string, Set<number>>();
    const push = (nodeId: string, timestampMs: number) => {
      let seen = used.get(nodeId);
      if (!seen) {
        seen = new Set();
        used.set(nodeId, seen);
      }
      while (seen.has(timestampMs)) timestampMs += 1;
      seen.add(timestampMs);
      beats.push({
        nodeId,
        timestampMs,
        cpu: Math.floor(rand() * 10001),
        memory: Math.floor(rand() * 10001),
        disk: Math.floor(rand() * 10001),
      });
    };

    // Regular noisy reporting over ~10 days, irregular spacing per node.
    for (const node of nodes) {
      let t = T0 + Math.floor(rand() * 60_000);
      while (t < T0 + 10 * 24 * HOUR_MS) {
        push(node, t);
        t += 30_000 + Math.floor(rand() * 600_000);
      }
    }
    // Long silence then a burst (backfilled later, out of order).
    const silent = "alpha";
    const silenceStart = T0 + 3 * 24 * HOUR_MS;
    const silenceEnd = T0 + 6 * 24 * HOUR_MS;
    for (let i = beats.length - 1; i >= 0; i--) {
      const b = beats[i];
      if (
        b.nodeId === silent &&
        b.timestampMs >= silenceStart &&
        b.timestampMs < silenceEnd
      ) {
        beats.splice(i, 1);
        used.get(silent)!.delete(b.timestampMs);
      }
    }
    for (let t = silenceEnd; t < silenceEnd + 2 * HOUR_MS; t += 45_000) {
      push(silent, t);
    }
    // A node that reports exactly once, deep in the past.
    push("echo", T0 + 1234);

    // Deterministic shuffle.
    for (let i = beats.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [beats[i], beats[j]] = [beats[j], beats[i]];
    }

    const actual = new HeartbeatRanker(nodes, T0);
    const expected = new ReferenceRanker(nodes, T0);

    // Clock advances in irregular steps, including multi-hour jumps,
    // independent of ingestion order.
    const advances: number[] = [];
    let clock = T0;
    while (clock < T0 + 12 * 24 * HOUR_MS) {
      clock += HOUR_MS + Math.floor(rand() * 20 * HOUR_MS);
      advances.push(clock);
    }

    let beatIdx = 0;
    let step = 0;
    for (const target of advances) {
      const chunk = Math.floor(rand() * 40);
      for (let k = 0; k < chunk && beatIdx < beats.length; k++, beatIdx++) {
        const b = beats[beatIdx];
        actual.ingest(b.nodeId, b.timestampMs, b.cpu, b.memory, b.disk);
        expected.ingest(b.nodeId, b.timestampMs, b.cpu, b.memory, b.disk);
      }
      actual.advanceTo(target);
      expected.advanceTo(target);
      compareAll(actual, expected, `after advance step ${step} to ${target}`);
      step++;
    }
    while (beatIdx < beats.length) {
      const b = beats[beatIdx++];
      actual.ingest(b.nodeId, b.timestampMs, b.cpu, b.memory, b.disk);
      expected.ingest(b.nodeId, b.timestampMs, b.cpu, b.memory, b.disk);
    }
    compareAll(actual, expected, "after final backfill");
    // Late-arriving heartbeat from the long-silence gap, after the clock
    // has already moved far past it: must still match the reference.
    const late = silenceStart + 500_000;
    actual.ingest(silent, late, 7777, 8888, 9999);
    expected.ingest(silent, late, 7777, 8888, 9999);
    compareAll(actual, expected, "after late backfill into silent gap");
  });
});

describe("72h window boundary", () => {
  it("heartbeat 1ms before the left edge still covers the window", () => {
    const nodes = ["n1", "n2"];
    const actual = new HeartbeatRanker(nodes, T0);
    const expected = new ReferenceRanker(nodes, T0);

    // Heartbeat first, then advance the clock.
    actual.ingest("n1", T0, 5000, 6000, 7000);
    expected.ingest("n1", T0, 5000, 6000, 7000);
    // Second node always inside the window so the ranking is non-trivial.
    actual.ingest("n2", T0 + 72 * HOUR_MS, 100, 100, 100);
    expected.ingest("n2", T0 + 72 * HOUR_MS, 100, 100, 100);

    // Heartbeat sits 1ms before the 72h window's left edge; its 300s hold
    // interval still covers [edge, edge + 299999ms) inside the window.
    const now1 = T0 + 72 * HOUR_MS + 1;
    actual.advanceTo(now1);
    expected.advanceTo(now1);
    for (const metric of METRICS) {
      const top = actual.top(72, metric);
      assertSameRanking(top, expected.top(72, metric));
      const n1 = top.find((e) => e.nodeId === "n1");
      assert.ok(n1, `n1 must be ranked for ${metric}`);
      assert.equal(n1.coverageMs, BigInt(HOLD_MS - 1));
    }

    // Advance until the hold interval ends exactly at the left edge:
    // [T0, T0+300000) vs window [T0+300000, now) -> fully expired.
    const now2 = T0 + 72 * HOUR_MS + HOLD_MS;
    actual.advanceTo(now2);
    expected.advanceTo(now2);
    for (const metric of METRICS) {
      const top = actual.top(72, metric);
      assertSameRanking(top, expected.top(72, metric));
      assert.ok(
        !top.some((e) => e.nodeId === "n1"),
        `n1 must be expired for ${metric}`,
      );
    }
  });
});

describe("semantics", () => {
  it("hold interval, unknown gaps, left-closed right-open, tie order", () => {
    const r = new HeartbeatRanker(["a", "b", "c"], 0);
    // a: value 100 held for exactly 300s, then unknown.
    r.ingest("a", 0, 100, 0, 0);
    // b: two beats 100s apart; first holds until the second (not 300s).
    r.ingest("b", 0, 100, 0, 0);
    r.ingest("b", 100_000, 300, 0, 0);
    // c: mean between a and b.
    r.ingest("c", 0, 50, 0, 0);
    r.ingest("c", 100_000, 150, 0, 0);
    r.advanceTo(HOUR_MS);

    const top = r.top(1, "cpu");
    assert.deepEqual(
      top.map((e) => e.nodeId),
      ["b", "c", "a"],
    );
    // b: 100*100000 + 300*300000 (second beat held for the full 300s)
    assert.equal(top[0].integral, 100n * 100_000n + 300n * 300_000n);
    assert.equal(top[0].coverageMs, 400_000n);
    // c: 50*100000 + 150*300000
    assert.equal(top[1].integral, 50n * 100_000n + 150n * 300_000n);
    assert.equal(top[1].coverageMs, 400_000n);
    // a: 100 * 300000
    assert.equal(top[2].integral, 100n * 300_000n);
    assert.equal(top[2].coverageMs, 300_000n);
  });

  it("exact tie falls back to nodeId ascending", () => {
    const r = new HeartbeatRanker(["zz", "aa", "mm"], 0);
    r.ingest("zz", 0, 100, 0, 0);
    r.ingest("aa", 0, 100, 0, 0);
    r.ingest("mm", 0, 100, 0, 0);
    r.advanceTo(1000);
    assert.deepEqual(
      r.top(1, "cpu").map((e) => e.nodeId),
      ["aa", "mm", "zz"],
    );
  });

  it("zero-coverage nodes are excluded", () => {
    const r = new HeartbeatRanker(["a", "b"], 0);
    r.ingest("a", 0, 100, 100, 100);
    r.advanceTo(10 * HOUR_MS);
    const top = r.top(1, "cpu");
    assert.deepEqual(top, []);
  });
});

describe("validation", () => {
  it("rejects unknown nodes, duplicates, bad windows and clock rewind", () => {
    const r = new HeartbeatRanker(["a"], 100);
    assert.throws(() => r.ingest("nope", 1, 1, 1, 1), /unknown nodeId/);
    r.ingest("a", 50, 1, 1, 1);
    assert.throws(() => r.ingest("a", 50, 2, 2, 2), /duplicate timestamp/);
    assert.throws(() => r.advanceTo(99), /backwards/);
    assert.throws(
      () => r.top(2 as WindowHours, "cpu"),
      /unsupported windowHours/,
    );
    assert.throws(
      () => r.top(1, "gpu" as Metric),
      /unknown metric/,
    );
    assert.throws(() => r.ingest("a", 60, 1.5, 1, 1), /integer/);
  });
});
