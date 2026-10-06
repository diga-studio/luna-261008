import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { TrafficGuard } from "../src/TrafficGuard";
import { RATE_ABUSE, ENDPOINT_SCAN } from "../src/types";
import { ReferenceGuard } from "./reference";

/** Deterministic PRNG so the random stream is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let z = Math.imul(a ^ (a >>> 15), 1 | a);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

test("random stream matches brute-force reference", () => {
  const rng = mulberry32(20261006);
  const guard = new TrafficGuard();
  const ref = new ReferenceGuard();
  const ips = ["ip-a", "ip-b", "ip-c", "ip-d"];
  const eps = Array.from({ length: 25 }, (_, i) => "/ep/" + i);

  let t = 1_000_000;
  for (let i = 0; i < 4000; i++) {
    // Advance time: mostly 0-2ms (same-ms bursts), sometimes seconds,
    // rarely a long silence that fully expires both windows.
    const jump = rng();
    if (jump < 0.02) {
      t += 301_000 + Math.floor(rng() * 100_000);
    } else if (jump < 0.1) {
      t += 1_000 + Math.floor(rng() * 5_000);
    } else {
      t += Math.floor(rng() * 3);
    }
    // Occasionally advance time without any request.
    if (rng() < 0.05) {
      const dt = Math.floor(rng() * 200_000);
      guard.advance(t + dt);
      ref.advance(t + dt);
      t += dt;
    }

    let ip: string;
    let ep: string;
    const m = rng();
    if (m < 0.25) {
      ip = "hot-ip";
      ep = "hot-ep";
    } else if (m < 0.5) {
      ip = "scan-ip";
      ep = "/scan/" + Math.floor(rng() * 40);
    } else {
      ip = ips[Math.floor(rng() * ips.length)]!;
      ep = eps[Math.floor(rng() * eps.length)]!;
    }

    const actual = guard.observe(ip, ep, t);
    const expected = ref.observe(ip, ep, t);
    deepEqual(
      actual,
      expected,
      `mismatch at event #${i}: ip=${ip} ep=${ep} t=${t}`,
    );
  }
});

test("thresholds, same-ms bursts, and exact window boundaries", () => {
  const g = new TrafficGuard();

  // --- RATE_ABUSE: 101st request within the same millisecond triggers. ---
  for (let i = 0; i < 100; i++) {
    deepEqual(g.observe("ip-rate", "/a", 10_000), []);
  }
  deepEqual(g.observe("ip-rate", "/a", 10_000), [RATE_ABUSE]);
  // Re-judged on every request, not only on the first threshold crossing.
  deepEqual(g.observe("ip-rate", "/a", 10_000), [RATE_ABUSE]);

  // No cross-IP crosstalk: another IP on the same endpoint starts fresh.
  deepEqual(g.observe("ip-other", "/a", 10_000), []);

  // Left-open boundary: at t=69999 the 101 requests at t=10000 still count.
  deepEqual(g.observe("ip-rate", "/a", 69_999), [RATE_ABUSE]);
  // At t=70000 the requests at exactly t-60000 are excluded; only the
  // request at 69999 and this one remain.
  deepEqual(g.observe("ip-rate", "/a", 70_000), []);

  // --- ENDPOINT_SCAN: 21st distinct endpoint within the same ms triggers. ---
  for (let i = 0; i < 20; i++) {
    deepEqual(g.observe("ip-scan", "/e" + i, 5_000), []);
  }
  deepEqual(g.observe("ip-scan", "/e20", 5_000), [ENDPOINT_SCAN]);
  // Still above the threshold on the next distinct endpoint.
  deepEqual(g.observe("ip-scan", "/e21", 5_000), [ENDPOINT_SCAN]);
  // Revisiting a known endpoint: the distinct count stays at 22, so the
  // request is still classified (judged per request, not per crossing).
  deepEqual(g.observe("ip-scan", "/e0", 5_000), [ENDPOINT_SCAN]);

  // --- Repeats do not increase the distinct count. ---
  const g5 = new TrafficGuard();
  for (let i = 0; i < 20; i++) {
    g5.observe("ip7", "/e" + i, 1_000);
  }
  // Many repeats of a known endpoint: never a 21st distinct endpoint.
  for (let i = 0; i < 50; i++) {
    deepEqual(g5.observe("ip7", "/e0", 2_000), []);
  }
  // The actual 21st distinct endpoint triggers exactly here.
  deepEqual(g5.observe("ip7", "/e20", 2_000), [ENDPOINT_SCAN]);

  // --- Endpoint survival: a repeat visit extends the endpoint's life. ---
  const g2 = new TrafficGuard();
  for (let i = 0; i < 21; i++) {
    g2.observe("ip4", "/e" + i, 1_000);
  }
  // Repeat /e0 much later: its 300s lifetime now extends to t=500000.
  g2.observe("ip4", "/e0", 200_000);
  // Advance past the expiry of the original batch (t=1000 <= 301000-300000),
  // while /e0 (last seen at 200000) survives.
  g2.advance(301_000);
  // Distinct count is now exactly 1 (/e0). 19 new endpoints reach 20: no hit.
  for (let i = 0; i < 19; i++) {
    deepEqual(g2.observe("ip4", "/n" + i, 301_000), []);
  }
  // The 21st distinct endpoint in the window triggers again.
  deepEqual(g2.observe("ip4", "/n19", 301_000), [ENDPOINT_SCAN]);

  // --- Expiry at the exact scan-window boundary (left-open). ---
  const g3 = new TrafficGuard();
  for (let i = 0; i < 21; i++) {
    g3.observe("ip5", "/e" + i, 1_000);
  }
  // One ms before the boundary everything still counts: 21 distinct + 1 new.
  deepEqual(g3.observe("ip5", "/x", 300_999), [ENDPOINT_SCAN]);
  // At t=301000 the endpoints seen at exactly t-300000 expire, so the
  // distinct count drops to 1 (/x) and a new endpoint gives no hit.
  deepEqual(g3.observe("ip5", "/y", 301_000), []);

  // --- advance() alone produces no classifications and expires state. ---
  const g4 = new TrafficGuard();
  for (let i = 0; i < 101; i++) {
    g4.observe("ip6", "/a", 1_000);
  }
  g4.advance(1_000_000); // long silence: everything expires
  deepEqual(g4.observe("ip6", "/a", 1_000_000), []);
});
