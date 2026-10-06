import { StatusRecord, TunnelDefinition, InterfaceStatus } from "../src/types";

/**
 * Independent reference: replays records per millisecond over the window.
 * Deliberately simple (brute force) so it can validate the sweep algorithm.
 */
export function referenceConnectedMs(
  tunnels: TunnelDefinition[],
  records: StatusRecord[],
  siteA: string,
  siteB: string,
  startMs: number,
  endMs: number
): number {
  const byId = new Map<string, StatusRecord>();
  for (const r of records) if (!byId.has(r.recordId)) byId.set(r.recordId, r);
  const effective = [...byId.values()];

  const pair = tunnels.filter(
    (t) =>
      (t.siteA === siteA && t.siteB === siteB) ||
      (t.siteA === siteB && t.siteB === siteA)
  );

  let connected = 0;
  for (let t = startMs; t < endMs; t++) {
    const state = new Map<string, string>();
    const best = new Map<string, StatusRecord>();
    for (const r of effective) {
      if (r.timestampMs > t) continue;
      const cur = best.get(r.objectId);
      if (
        !cur ||
        r.timestampMs > cur.timestampMs ||
        (r.timestampMs === cur.timestampMs && r.seq > cur.seq)
      ) {
        best.set(r.objectId, r);
      }
    }
    for (const [id, r] of best) state.set(id, r.state);

    const up = (id: string, isTunnel: boolean): boolean => {
      const s = state.get(id);
      if (s === undefined) return false;
      return isTunnel ? s === "Active" : s === InterfaceStatus.Up;
    };
    const ok = pair.some(
      (tun) =>
        up(tun.tunnelId, true) &&
        up(tun.interfaceA, false) &&
        up(tun.interfaceB, false)
    );
    if (ok) connected++;
  }
  return connected;
}

/** Seeded PRNG (mulberry32) for reproducible randomized tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
