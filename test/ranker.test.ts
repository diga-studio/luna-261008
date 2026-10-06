import test from 'node:test';
import assert from 'node:assert/strict';
import { HeartbeatRanker, MAX_HOLD_MS } from '../src/heartbeat-ranker.js';
import type { MetricKind, RankEntry, WindowHours } from '../src/types.js';
import { ReferenceRanker } from './reference.js';

const HOUR_MS = 3_600_000;
const WINDOWS: WindowHours[] = [1, 6, 12, 24, 48, 72];
const METRICS: MetricKind[] = ['cpu', 'memory', 'disk'];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compareAll(actual: HeartbeatRanker, expected: ReferenceRanker, ctx: string): void {
  for (const windowHours of WINDOWS) {
    for (const metric of METRICS) {
      const a = actual.top(windowHours, metric);
      const e = expected.top(windowHours, metric);
      assert.deepEqual(
        a.map(simplify),
        e.map(simplify),
        `${ctx}: window=${windowHours}h metric=${metric}`,
      );
    }
  }
}

function simplify(entry: RankEntry): [string, number, number, number] {
  return [entry.nodeId, entry.integral, entry.coverageMs, entry.mean];
}

test('deterministic shuffled ingest with long-silence backfill matches sorted-history reference', () => {
  const nodeIds = ['alpha', 'beta', 'gamma', 'delta'];
  const t0 = 1_700_000_000_000;
  const rand = rng(0xC0FFEE);

  interface Beat {
    nodeId: string;
    timestampMs: number;
    cpu: number;
    memory: number;
    disk: number;
  }
  const beats: Beat[] = [];
  const metric = () => Math.floor(rand() * 10001);

  // Regular traffic for all nodes over ~80 hours.
  for (const nodeId of nodeIds) {
    let t = t0 - 5 * HOUR_MS + Math.floor(rand() * HOUR_MS);
    while (t < t0 + 80 * HOUR_MS) {
      beats.push({ nodeId, timestampMs: t, cpu: metric(), memory: metric(), disk: metric() });
      t += 60_000 + Math.floor(rand() * 600_000);
    }
  }
  // Long silence for beta: drop everything in [t0+10h, t0+40h) ...
  const silenceStart = t0 + 10 * HOUR_MS;
  const silenceEnd = t0 + 40 * HOUR_MS;
  const kept = beats.filter((b) => !(b.nodeId === 'beta' && b.timestampMs >= silenceStart && b.timestampMs < silenceEnd));
  // ... then backfill heartbeats inside the silent gap, ingested late and out of order.
  const backfill: Beat[] = [];
  for (let t = silenceStart + 123_456; t < silenceEnd; t += 3_700_000) {
    backfill.push({ nodeId: 'beta', timestampMs: t, cpu: metric(), memory: metric(), disk: metric() });
  }

  const main = [...kept];
  // Deterministic shuffle of the main sequence.
  for (let i = main.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [main[i], main[j]] = [main[j]!, main[i]!];
  }
  // Backfilled beats are appended at the end (they arrive late), also shuffled.
  for (let i = backfill.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [backfill[i], backfill[j]] = [backfill[j]!, backfill[i]!];
  }
  const sequence = [...main, ...backfill];

  const actual = new HeartbeatRanker(nodeIds, t0);
  const expected = new ReferenceRanker(nodeIds, t0);

  let step = 0;
  for (const beat of sequence) {
    actual.ingest(beat.nodeId, beat.timestampMs, beat.cpu, beat.memory, beat.disk);
    expected.ingest(beat.nodeId, beat.timestampMs, beat.cpu, beat.memory, beat.disk);
    step++;
    compareAll(actual, expected, `after ingest #${step} (${beat.nodeId}@${beat.timestampMs})`);
    // Periodically jump the clock forward, sometimes by many hours at once.
    if (step % 9 === 0) {
      const jump = [HOUR_MS, 7 * HOUR_MS, 26 * HOUR_MS, 2 * HOUR_MS, 49 * HOUR_MS][Math.floor(rand() * 5)]!;
      const now = (actual as { clockMs: number }).clockMs + jump;
      actual.advanceTo(now);
      expected.advanceTo(now);
      compareAll(actual, expected, `after advanceTo(${now}) at step ${step}`);
    }
  }
});

test('heartbeat 1ms before the 72h window edge still counts, then fully expires', () => {
  const t0 = 1_700_000_000_000;
  const ranker = new HeartbeatRanker(['n1', 'n2'], t0);

  ranker.ingest('n1', t0, 5000, 2500, 9999);
  ranker.ingest('n2', t0 + 71 * HOUR_MS, 6000, 3000, 1000);

  // Clock such that the n1 heartbeat sits 1ms before the 72h window's left edge,
  // but its 300000ms hold interval still reaches into the window.
  ranker.advanceTo(t0 + 72 * HOUR_MS + 1);

  const top72 = ranker.top(72, 'cpu');
  assert.equal(top72.length, 2);
  // n2 (mean 6000) outranks n1 (mean 5000).
  assert.equal(top72[0]!.nodeId, 'n2');
  assert.equal(top72[0]!.coverageMs, MAX_HOLD_MS);
  assert.equal(top72[0]!.mean, 6000);
  assert.equal(top72[1]!.nodeId, 'n1');
  assert.equal(top72[1]!.coverageMs, MAX_HOLD_MS - 1);
  assert.equal(top72[1]!.integral, 5000 * (MAX_HOLD_MS - 1));
  assert.equal(top72[1]!.mean, 5000);

  // The 1h window starts after n1's hold interval ends: n1 absent.
  const top1 = ranker.top(1, 'cpu');
  assert.deepEqual(top1.map((e) => e.nodeId), ['n2']);
  assert.equal(top1[0]!.coverageMs, MAX_HOLD_MS - 1);

  // Advance to 1ms before n1's hold interval fully leaves the 72h window:
  // exactly 1ms of coverage remains (intervals are left-closed, right-open).
  ranker.advanceTo(t0 + 72 * HOUR_MS + MAX_HOLD_MS - 1);
  const almostGone = ranker.top(72, 'cpu');
  const n1Entry = almostGone.find((e) => e.nodeId === 'n1');
  assert.ok(n1Entry);
  assert.equal(n1Entry.coverageMs, 1);
  assert.equal(n1Entry.integral, 5000);

  // Advance past full expiry: n1's interval no longer touches the window.
  ranker.advanceTo(t0 + 72 * HOUR_MS + MAX_HOLD_MS);
  const gone = ranker.top(72, 'cpu');
  assert.deepEqual(gone.map((e) => e.nodeId), ['n2']);
  for (const metric of METRICS) {
    assert.deepEqual(ranker.top(72, metric).map((e) => e.nodeId), ['n2']);
  }
});

test('rejects invalid usage', () => {
  const ranker = new HeartbeatRanker(['a'], 1000);
  assert.throws(() => ranker.ingest('nope', 1000, 1, 1, 1), /unknown nodeId/);
  ranker.ingest('a', 1000, 1, 2, 3);
  assert.throws(() => ranker.ingest('a', 1000, 4, 5, 6), /duplicate timestamp/);
  assert.throws(() => ranker.ingest('a', 2000, 1.5, 1, 1), /integer/);
  assert.throws(() => ranker.advanceTo(999), /monotonically/);
  assert.throws(() => ranker.top(3 as WindowHours, 'cpu'), /unsupported windowHours/);
});
