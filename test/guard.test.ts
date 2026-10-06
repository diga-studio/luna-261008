import test from "node:test";
import assert from "node:assert/strict";
import { TrafficGuard, type Classification } from "../src/index";

const RATE_WINDOW = 60_000;
const RATE_MAX = 100;
const SCAN_WINDOW = 300_000;
const SCAN_MAX = 20;

interface Event {
  ip: string;
  endpoint: string;
  t: number;
}

function referenceClassify(events: Event[], idx: number): Set<Classification> {
  const { ip, endpoint, t } = events[idx]!;
  let rateCount = 0;
  const endpoints = new Set<string>();
  for (let j = 0; j <= idx; j++) {
    const e = events[j]!;
    if (e.ip !== ip || e.t > t) continue;
    if (e.endpoint === endpoint && e.t > t - RATE_WINDOW) rateCount += 1;
    if (e.t > t - SCAN_WINDOW) endpoints.add(e.endpoint);
  }
  const hits = new Set<Classification>();
  if (rateCount > RATE_MAX) hits.add("RATE_ABUSE");
  if (endpoints.size > SCAN_MAX) hits.add("ENDPOINT_SCAN");
  return hits;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test("random stream matches brute-force reference per request", () => {
  const rand = mulberry32(26100830);
  const ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "192.168.1.5", "172.16.0.9"];
  const endpoints = Array.from({ length: 30 }, (_, i) => `/api/v1/res${i}`);

  const guard = new TrafficGuard();
  const events: Event[] = [];
  let t = 1_000_000;

  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

  for (let i = 0; i < 3000; i++) {
    const roll = rand();
    if (roll < 0.04) {
      // burst: same ip+endpoint many times within one millisecond
      const ip = pick(ips);
      const ep = pick(endpoints);
      const n = 90 + Math.floor(rand() * 30);
      for (let k = 0; k < n; k++) events.push({ ip, endpoint: ep, t });
    } else if (roll < 0.08) {
      // scan burst: one ip touches many distinct endpoints quickly
      const ip = pick(ips);
      const n = 15 + Math.floor(rand() * 12);
      for (let k = 0; k < n; k++) {
        events.push({ ip, endpoint: `/probe/${Math.floor(rand() * 40)}`, t });
        t += Math.floor(rand() * 3);
      }
    } else if (roll < 0.1) {
      // long silence: advance far beyond both windows
      t += 400_000 + Math.floor(rand() * 600_000);
      guard.advance(t);
      continue;
    } else if (roll < 0.14) {
      // time jump without requests
      t += 1_000 + Math.floor(rand() * 50_000);
      guard.advance(t);
      continue;
    } else {
      events.push({ ip: pick(ips), endpoint: pick(endpoints), t });
      t += Math.floor(rand() * 50);
    }
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const actual = guard.observe(e.ip, e.endpoint, e.t);
    const expected = referenceClassify(events, i);
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `mismatch at event #${i} ${JSON.stringify(e)}`,
    );
  }
});

test("101st request in same millisecond triggers RATE_ABUSE, re-evaluated per request", () => {
  const guard = new TrafficGuard();
  const t0 = 5_000;
  for (let i = 0; i < 100; i++) {
    const hits = guard.observe("1.1.1.1", "/pay", t0);
    assert.deepEqual([...hits], [], `request #${i + 1} must not be classified`);
  }
  const hits101 = guard.observe("1.1.1.1", "/pay", t0);
  assert.deepEqual([...hits101], ["RATE_ABUSE"]);
  const hits102 = guard.observe("1.1.1.1", "/pay", t0);
  assert.deepEqual([...hits102], ["RATE_ABUSE"], "classification is re-evaluated, not first-crossing only");
});

test("21st distinct endpoint triggers ENDPOINT_SCAN, repeats do not increase variety", () => {
  const guard = new TrafficGuard();
  const t0 = 7_000;
  for (let i = 0; i < 20; i++) {
    const hits = guard.observe("2.2.2.2", `/e${i}`, t0);
    assert.deepEqual([...hits], [], `endpoint #${i + 1} must not be classified`);
  }
  for (let i = 0; i < 20; i++) {
    const hits = guard.observe("2.2.2.2", `/e${i}`, t0 + 10);
    assert.deepEqual([...hits], [], "revisiting known endpoints must not increase variety");
  }
  const hits21 = guard.observe("2.2.2.2", "/e20", t0 + 10);
  assert.deepEqual([...hits21], ["ENDPOINT_SCAN"]);
});

test("rate window left boundary is exclusive", () => {
  const guard = new TrafficGuard();
  const t0 = 10_000;
  for (let i = 0; i < 101; i++) guard.observe("3.3.3.3", "/a", t0);

  guard.advance(t0 + RATE_WINDOW - 1); // cutoff = t0 - 1, all 101 still inside
  const stillHot = guard.observe("3.3.3.3", "/a", t0 + RATE_WINDOW - 1);
  assert.deepEqual([...stillHot], ["RATE_ABUSE"]);

  guard.advance(t0 + RATE_WINDOW); // cutoff = t0, requests at exactly t0 expire
  const fresh = guard.observe("3.3.3.3", "/a", t0 + RATE_WINDOW);
  assert.deepEqual([...fresh], [], "requests at t - window must not be counted");
});

test("scan window left boundary is exclusive and revisit extends endpoint survival", () => {
  const guard = new TrafficGuard();
  const ip = "4.4.4.4";

  guard.observe(ip, "/old", 0); // lastSeen(/old) = 0
  for (let i = 0; i < 19; i++) guard.observe(ip, `/f${i}`, 250_000);
  // 20 distinct endpoints alive at t=250000; /old would expire at t=300000 without a revisit
  const revisit = guard.observe(ip, "/old", 290_000);
  assert.deepEqual([...revisit], [], "revisit of a live endpoint keeps variety at 20");

  // At t=549999 cutoff is 249999: /f* (lastSeen 250000) and /old (lastSeen 290000) all alive.
  // /old survives past 300000 only because the revisit extended its lifetime.
  const hits = guard.observe(ip, "/new", 549_999);
  assert.deepEqual([...hits], ["ENDPOINT_SCAN"], "revisited endpoint must still count as alive");

  // At t=550000 cutoff is 250000: /f* expire exactly at the boundary, /old and /new survive.
  guard.advance(550_000);
  const after = guard.observe(ip, "/another", 550_000);
  assert.deepEqual([...after], [], "endpoints at exactly t - window must expire");
});

test("no cross-talk between IPs", () => {
  const guard = new TrafficGuard();
  const t0 = 20_000;
  for (let i = 0; i < 101; i++) guard.observe("5.5.5.5", "/x", t0);
  for (let i = 0; i < 21; i++) guard.observe("5.5.5.5", `/s${i}`, t0);

  const other = guard.observe("6.6.6.6", "/x", t0);
  assert.deepEqual([...other], [], "other IP must start with clean counters");

  const selfRate = guard.observe("5.5.5.5", "/x", t0);
  assert.ok(selfRate.has("RATE_ABUSE"));
  assert.ok(selfRate.has("ENDPOINT_SCAN"));
});

test("both classifications can hit on the same request", () => {
  const guard = new TrafficGuard();
  const t0 = 30_000;
  for (let i = 0; i < 20; i++) guard.observe("7.7.7.7", `/d${i}`, t0);
  for (let i = 0; i < 100; i++) guard.observe("7.7.7.7", "/hot", t0);
  const hits = guard.observe("7.7.7.7", "/hot", t0);
  assert.deepEqual([...hits].sort(), ["ENDPOINT_SCAN", "RATE_ABUSE"]);
});

test("classified requests still participate in later statistics", () => {
  const guard = new TrafficGuard();
  const t0 = 40_000;
  for (let i = 0; i < 101; i++) guard.observe("8.8.8.8", "/y", t0);
  // The 101 classified requests remain in the window: one more at t0+1 is still abuse.
  const hits = guard.observe("8.8.8.8", "/y", t0 + 1);
  assert.ok(hits.has("RATE_ABUSE"));
});
