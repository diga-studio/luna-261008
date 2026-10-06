import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TunnelAvailabilityLibrary,
  InterfaceStatus,
  ObjectKind,
  StatusRecord,
  TunnelDefinition,
} from "../src/index";
import { referenceConnectedMs, mulberry32 } from "./helpers";

let seqCounter = 0;
function rec(
  objectId: string,
  objectKind: ObjectKind,
  timestampMs: number,
  seq: number,
  state: string,
  recordId?: string
): StatusRecord {
  return {
    recordId: recordId ?? `r${seqCounter++}`,
    objectId,
    objectKind,
    timestampMs,
    seq,
    state,
  };
}

const TUNNEL_AB: TunnelDefinition = {
  tunnelId: "tun1",
  siteA: "A",
  siteB: "B",
  interfaceA: "ifA1",
  interfaceB: "ifB1",
};

function setupLib(tunnels: TunnelDefinition[]): {
  lib: TunnelAvailabilityLibrary;
  records: StatusRecord[];
  push: (r: StatusRecord) => void;
} {
  const lib = new TunnelAvailabilityLibrary(":memory:");
  for (const t of tunnels) lib.addTunnel(t);
  const records: StatusRecord[] = [];
  const push = (r: StatusRecord) => {
    records.push(r);
    lib.addStatusRecord(r);
  };
  return { lib, records, push };
}

function bringUp(
  push: (r: StatusRecord) => void,
  tun: TunnelDefinition,
  ts: number
): void {
  push(rec(tun.interfaceA, ObjectKind.Interface, ts, 1, InterfaceStatus.Up));
  push(rec(tun.interfaceB, ObjectKind.Interface, ts, 1, InterfaceStatus.Up));
  push(rec(tun.tunnelId, ObjectKind.Tunnel, ts, 1, "Active"));
}

test("basic: fault crossing window boundary only counts in-window part", () => {
  const { lib, push } = setupLib([TUNNEL_AB]);
  bringUp(push, TUNNEL_AB, 0);
  // Interface fails at 500 (before window), recovers at 1500 (inside window).
  push(rec("ifA1", ObjectKind.Interface, 500, 2, InterfaceStatus.Down));
  push(rec("ifA1", ObjectKind.Interface, 1500, 3, InterfaceStatus.Up));

  const r = lib.report("A", "B", 1000, 2000);
  assert.equal(r.connectedMs, 500); // [1500, 2000)
  assert.equal(r.availability, 0.5);
  lib.close();
});

test("window-start state carries in; no records inside window", () => {
  const { lib, push } = setupLib([TUNNEL_AB]);
  bringUp(push, TUNNEL_AB, 10);
  const r = lib.report("A", "B", 1000, 3000);
  assert.equal(r.connectedMs, 2000);
  assert.equal(r.availability, 1);
  lib.close();
});

test("before first record everything is down", () => {
  const { lib } = setupLib([TUNNEL_AB]);
  const r = lib.report("A", "B", 0, 1000);
  assert.equal(r.connectedMs, 0);
  lib.close();
});

test("shared interface failure hits all tunnels; overlap counted once", () => {
  const tun2: TunnelDefinition = {
    tunnelId: "tun2",
    siteA: "A",
    siteB: "B",
    interfaceA: "ifA1", // shared with tun1
    interfaceB: "ifB2",
  };
  const { lib, records, push } = setupLib([TUNNEL_AB, tun2]);
  bringUp(push, TUNNEL_AB, 0);
  bringUp(push, tun2, 0);
  // Shared interface down [100, 300): both tunnels down.
  push(rec("ifA1", ObjectKind.Interface, 100, 2, InterfaceStatus.Down));
  push(rec("ifA1", ObjectKind.Interface, 300, 3, InterfaceStatus.Up));

  const r = lib.report("A", "B", 0, 1000);
  assert.equal(r.connectedMs, 800);
  assert.equal(
    r.connectedMs,
    referenceConnectedMs([TUNNEL_AB, tun2], records, "A", "B", 0, 1000)
  );
  lib.close();
});

test("parallel tunnel handover in the same millisecond leaves no gap", () => {
  const tun2: TunnelDefinition = {
    tunnelId: "tun2",
    siteA: "A",
    siteB: "B",
    interfaceA: "ifA2",
    interfaceB: "ifB2",
  };
  const { lib, records, push } = setupLib([TUNNEL_AB, tun2]);
  bringUp(push, TUNNEL_AB, 0);
  bringUp(push, tun2, 0);
  // tun2 goes down at 100 (its own interface fails).
  push(rec("ifA2", ObjectKind.Interface, 100, 2, InterfaceStatus.Down));
  // At t=500 tun1 fails and tun2 recovers in the very same millisecond.
  push(rec("ifA1", ObjectKind.Interface, 500, 2, InterfaceStatus.Down));
  push(rec("ifA2", ObjectKind.Interface, 500, 3, InterfaceStatus.Up));

  const r = lib.report("A", "B", 0, 1000);
  assert.equal(r.connectedMs, 1000); // no gap at t=500
  assert.equal(r.availability, 1);
  assert.equal(
    r.connectedMs,
    referenceConnectedMs([TUNNEL_AB, tun2], records, "A", "B", 0, 1000)
  );
  lib.close();
});

test("out-of-order, duplicate, and same-ms max-seq resolution", () => {
  const { lib, records, push } = setupLib([TUNNEL_AB]);
  // Arrive out of order: later business time first.
  push(rec("ifA1", ObjectKind.Interface, 200, 1, InterfaceStatus.Up));
  push(rec("ifB1", ObjectKind.Interface, 200, 1, InterfaceStatus.Up));
  push(rec("tun1", ObjectKind.Tunnel, 200, 1, "Active"));
  push(rec("ifA1", ObjectKind.Interface, 100, 1, InterfaceStatus.Up)); // earlier, late
  // Duplicate of an existing record: same id, must apply only once.
  const dup = rec("tun1", ObjectKind.Tunnel, 400, 2, "Inactive", "dup-1");
  push(dup);
  push(dup);
  // Same object, same ms=600: seq 5 (Down) arrives before seq 7 (Up).
  push(rec("ifA1", ObjectKind.Interface, 600, 5, InterfaceStatus.Down));
  push(rec("ifA1", ObjectKind.Interface, 600, 7, InterfaceStatus.Up));

  const r = lib.report("A", "B", 0, 1000);
  // Up from 200; tunnel Inactive at 400 => down [400, 600); ifA1 Up at 600
  // (max seq wins) but tunnel still Inactive => stays down to 1000.
  assert.equal(r.connectedMs, 200);
  assert.equal(
    r.connectedMs,
    referenceConnectedMs([TUNNEL_AB], records, "A", "B", 0, 1000)
  );
  lib.close();
});

test("late record changes an already-queried window", () => {
  const { lib, records, push } = setupLib([TUNNEL_AB]);
  bringUp(push, TUNNEL_AB, 0);

  const before = lib.report("A", "B", 0, 1000);
  assert.equal(before.connectedMs, 1000);

  // Late-arriving outage [300, 700) rewrites the queried history.
  push(rec("ifB1", ObjectKind.Interface, 300, 2, InterfaceStatus.Down));
  push(rec("ifB1", ObjectKind.Interface, 700, 3, InterfaceStatus.Up));

  const after = lib.report("A", "B", 0, 1000);
  assert.equal(after.connectedMs, 600);
  assert.equal(
    after.connectedMs,
    referenceConnectedMs([TUNNEL_AB], records, "A", "B", 0, 1000)
  );
  lib.close();
});

test("tunnel only counts as up in Active lifecycle state", () => {
  const { lib, push } = setupLib([TUNNEL_AB]);
  push(rec("ifA1", ObjectKind.Interface, 0, 1, InterfaceStatus.Up));
  push(rec("ifB1", ObjectKind.Interface, 0, 1, InterfaceStatus.Up));
  push(rec("tun1", ObjectKind.Tunnel, 0, 1, "Standby"));
  assert.equal(lib.report("A", "B", 0, 1000).connectedMs, 0);
  push(rec("tun1", ObjectKind.Tunnel, 400, 2, "Active"));
  assert.equal(lib.report("A", "B", 0, 1000).connectedMs, 600);
  lib.close();
});

test("randomized scenario matches independent reference", () => {
  const rand = mulberry32(42);
  const tunnels: TunnelDefinition[] = [
    { tunnelId: "t1", siteA: "A", siteB: "B", interfaceA: "ifA1", interfaceB: "ifB1" },
    { tunnelId: "t2", siteA: "A", siteB: "B", interfaceA: "ifA1", interfaceB: "ifB2" },
    { tunnelId: "t3", siteA: "A", siteB: "B", interfaceA: "ifA3", interfaceB: "ifB3" },
    { tunnelId: "t4", siteA: "A", siteB: "C", interfaceA: "ifA9", interfaceB: "ifC1" },
  ];
  const lib = new TunnelAvailabilityLibrary(":memory:");
  for (const t of tunnels) lib.addTunnel(t);

  const objects: { id: string; kind: ObjectKind; states: string[] }[] = [
    { id: "t1", kind: ObjectKind.Tunnel, states: ["Active", "Inactive", "Maintenance"] },
    { id: "t2", kind: ObjectKind.Tunnel, states: ["Active", "Inactive"] },
    { id: "t3", kind: ObjectKind.Tunnel, states: ["Active", "Standby"] },
    { id: "t4", kind: ObjectKind.Tunnel, states: ["Active", "Inactive"] },
    ...["ifA1", "ifA3", "ifA9", "ifB1", "ifB2", "ifB3", "ifC1"].map((id) => ({
      id,
      kind: ObjectKind.Interface,
      states: [InterfaceStatus.Up, InterfaceStatus.Down] as string[],
    })),
  ];

  const records: StatusRecord[] = [];
  let n = 0;
  for (const obj of objects) {
    const perSeq = new Map<number, number>();
    for (let i = 0; i < 12; i++) {
      const ts = Math.floor(rand() * 2000);
      const s = 1 + Math.floor(rand() * 10);
      perSeq.set(s, ts); // keep seq unique per object
      records.push(
        rec(obj.id, obj.kind, ts, s, obj.states[Math.floor(rand() * obj.states.length)], `g${n++}`)
      );
    }
  }
  // Shuffle arrival order and inject duplicates.
  for (let i = records.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [records[i], records[j]] = [records[j], records[i]];
  }
  const arrived = [...records, records[3], records[10], records[3]];
  for (const r of arrived) lib.addStatusRecord(r);

  for (let w = 0; w < 10; w++) {
    const startMs = Math.floor(rand() * 1500);
    const endMs = startMs + 1 + Math.floor(rand() * 800);
    const got = lib.report("A", "B", startMs, endMs);
    const want = referenceConnectedMs(tunnels, records, "A", "B", startMs, endMs);
    assert.equal(got.connectedMs, want, `window [${startMs}, ${endMs})`);
    assert.equal(got.availability, want / (endMs - startMs));
  }
  // Site pair with a single tunnel and a pair with no tunnels.
  const ac = lib.report("A", "C", 0, 2000);
  assert.equal(ac.connectedMs, referenceConnectedMs(tunnels, records, "A", "C", 0, 2000));
  assert.equal(lib.report("B", "C", 0, 2000).connectedMs, 0);
  lib.close();
});
