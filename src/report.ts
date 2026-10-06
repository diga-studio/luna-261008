import { DatabaseSync } from "node:sqlite";
import { AvailabilityReport, InterfaceStatus, ObjectKind } from "./types";

interface TunnelRow {
  tunnel_id: string;
  site_a: string;
  site_b: string;
  interface_a: string;
  interface_b: string;
}

interface RecordRow {
  object_id: string;
  ts_ms: number;
  seq: number;
  state: string;
}

interface Event {
  ts: number;
  objectId: string;
  state: string;
}

const TUNNEL_ACTIVE = "Active";

/** Compute the availability report for a site pair over [startMs, endMs). */
export function computeReport(
  db: DatabaseSync,
  siteA: string,
  siteB: string,
  startMs: number,
  endMs: number
): AvailabilityReport {
  const windowMs = endMs - startMs;
  const report: AvailabilityReport = {
    siteA,
    siteB,
    windowStartMs: startMs,
    windowEndMs: endMs,
    connectedMs: 0,
    availability: 0,
  };
  if (windowMs <= 0) return report;

  const tunnels = db
    .prepare(
      `SELECT tunnel_id, site_a, site_b, interface_a, interface_b
       FROM tunnels
       WHERE (site_a = ? AND site_b = ?) OR (site_a = ? AND site_b = ?)`
    )
    .all(siteA, siteB, siteB, siteA) as unknown as TunnelRow[];
  if (tunnels.length === 0) return report;

  const objectIds = new Set<string>();
  for (const t of tunnels) {
    objectIds.add(t.tunnel_id);
    objectIds.add(t.interface_a);
    objectIds.add(t.interface_b);
  }

  const placeholders = [...objectIds].map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT object_id, ts_ms, seq, state
       FROM status_records
       WHERE object_id IN (${placeholders}) AND ts_ms < ?
       ORDER BY object_id, ts_ms, seq`
    )
    .all(...objectIds, endMs) as unknown as RecordRow[];

  // Collapse to effective events: within one object and one millisecond,
  // only the record with the highest seq takes effect.
  const events: Event[] = [];
  let prev: RecordRow | null = null;
  for (const row of rows) {
    if (prev && (prev.object_id !== row.object_id || prev.ts_ms !== row.ts_ms)) {
      events.push({ ts: prev.ts_ms, objectId: prev.object_id, state: prev.state });
    }
    prev = row;
  }
  if (prev) events.push({ ts: prev.ts_ms, objectId: prev.object_id, state: prev.state });
  events.sort((a, b) => a.ts - b.ts);

  const kinds = new Map<string, ObjectKind>();
  for (const t of tunnels) {
    kinds.set(t.tunnel_id, ObjectKind.Tunnel);
    kinds.set(t.interface_a, ObjectKind.Interface);
    kinds.set(t.interface_b, ObjectKind.Interface);
  }

  const states = new Map<string, string>();
  const isUp = (objectId: string): boolean => {
    const state = states.get(objectId);
    if (state === undefined) return false; // before first record: always down
    return kinds.get(objectId) === ObjectKind.Tunnel
      ? state === TUNNEL_ACTIVE
      : state === InterfaceStatus.Up;
  };
  const connected = (): boolean =>
    tunnels.some(
      (t) => isUp(t.tunnel_id) && isUp(t.interface_a) && isUp(t.interface_b)
    );

  // Replay events strictly before the window to establish the state at startMs.
  let idx = 0;
  while (idx < events.length && events[idx].ts < startMs) {
    const ts = events[idx].ts;
    while (idx < events.length && events[idx].ts === ts) {
      states.set(events[idx].objectId, events[idx].state);
      idx++;
    }
  }

  // Sweep the window; intervals between same-ms events have zero length,
  // so simultaneous changes never create phantom gaps.
  let cursor = startMs;
  let connectedMs = 0;
  while (idx < events.length) {
    const ts = events[idx].ts;
    if (connected()) connectedMs += ts - cursor;
    while (idx < events.length && events[idx].ts === ts) {
      states.set(events[idx].objectId, events[idx].state);
      idx++;
    }
    cursor = ts;
  }
  if (connected()) connectedMs += endMs - cursor;

  report.connectedMs = connectedMs;
  report.availability = connectedMs / windowMs;
  return report;
}
