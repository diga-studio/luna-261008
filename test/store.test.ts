import { test } from "node:test";
import assert from "node:assert/strict";
import { ComponentStore, LEASE_TTL_MS } from "../src/store";
import { ManualClock } from "../src/clock";
import type { Lease } from "../src/types";

function checkoutMust(
  store: ComponentStore,
  actor: string,
  id: string,
): Lease {
  const result = store.checkout(actor, id);
  assert.ok(result.ok, `checkout ${id} by ${actor} should succeed`);
  return result.lease;
}

test("cycle: A->B and B->A committed separately, exactly one succeeds", () => {
  const store = new ComponentStore(new ManualClock());
  const leaseA = checkoutMust(store, "alice", "A");
  const leaseB = checkoutMust(store, "alice", "B");

  const created = store.save(
    "alice",
    [
      { kind: "create", id: "A" },
      { kind: "create", id: "B" },
    ],
    [leaseA, leaseB],
  );
  assert.ok(created.ok);

  const ab = store.save(
    "alice",
    [{ kind: "setDependsOn", id: "A", dependsOn: ["B"] }],
    [leaseA],
  );
  assert.ok(ab.ok);

  const ba = store.save(
    "alice",
    [{ kind: "setDependsOn", id: "B", dependsOn: ["A"] }],
    [leaseB],
  );
  assert.ok(!ba.ok);
  if (!ba.ok) assert.equal(ba.error.code, "cycle");

  const graph = store.read();
  assert.deepEqual(graph.get("A"), { id: "A", dependsOn: ["B"] });
  assert.deepEqual(graph.get("B"), { id: "B", dependsOn: [] });
});

test("expiry: re-checkout after expiry, old lease cannot save or overwrite", () => {
  const clock = new ManualClock();
  const store = new ComponentStore(clock);

  const oldLease = checkoutMust(store, "alice", "X");
  clock.advance(LEASE_TTL_MS + 1);

  const blocked = store.save(
    "alice",
    [{ kind: "create", id: "X" }],
    [oldLease],
  );
  assert.ok(!blocked.ok);
  if (!blocked.ok) assert.equal(blocked.error.code, "no-valid-lease");

  const newLease = checkoutMust(store, "bob", "X");
  assert.ok(newLease.token !== oldLease.token);

  const saved = store.save(
    "bob",
    [{ kind: "create", id: "X", dependsOn: [] }],
    [newLease],
  );
  assert.ok(saved.ok);

  const stale = store.save(
    "alice",
    [{ kind: "setDependsOn", id: "X", dependsOn: [] }],
    [oldLease],
  );
  assert.ok(!stale.ok);
  if (!stale.ok) assert.equal(stale.error.code, "no-valid-lease");

  const aliceCheckout = store.checkout("alice", "X");
  assert.ok(!aliceCheckout.ok);
  if (!aliceCheckout.ok) assert.equal(aliceCheckout.holder, "bob");

  const graph = store.read();
  assert.deepEqual(graph.get("X"), { id: "X", dependsOn: [] });
});

test("failed save does not renew the lease", () => {
  const clock = new ManualClock();
  const store = new ComponentStore(clock);
  const lease = checkoutMust(store, "alice", "X");

  clock.advance(LEASE_TTL_MS - 1);
  const failed = store.save(
    "alice",
    [{ kind: "create", id: "X", dependsOn: ["MISSING"] }],
    [lease],
  );
  assert.ok(!failed.ok);

  clock.advance(2);
  const late = store.save("alice", [{ kind: "create", id: "X" }], [lease]);
  assert.ok(!late.ok);
  if (!late.ok) assert.equal(late.error.code, "no-valid-lease");
});

test("successful save renews the lease", () => {
  const clock = new ManualClock();
  const store = new ComponentStore(clock);
  const lease = checkoutMust(store, "alice", "X");

  clock.advance(LEASE_TTL_MS - 1);
  const saved = store.save("alice", [{ kind: "create", id: "X" }], [lease]);
  assert.ok(saved.ok);

  clock.advance(LEASE_TTL_MS - 1);
  const stillValid = store.save(
    "alice",
    [{ kind: "setDependsOn", id: "X", dependsOn: [] }],
    [lease],
  );
  assert.ok(stillValid.ok);
});

test("same actor re-checkout renews; other actor is rejected while valid", () => {
  const clock = new ManualClock();
  const store = new ComponentStore(clock);
  const first = checkoutMust(store, "alice", "X");

  clock.advance(LEASE_TTL_MS - 1);
  const second = checkoutMust(store, "alice", "X");
  assert.ok(second.expiresAt > first.expiresAt);

  const denied = store.checkout("bob", "X");
  assert.ok(!denied.ok);
  if (!denied.ok) assert.equal(denied.holder, "alice");

  clock.advance(LEASE_TTL_MS - 1);
  const stillDenied = store.checkout("bob", "X");
  assert.ok(!stillDenied.ok);
});

test("same-batch create and reference is allowed", () => {
  const store = new ComponentStore(new ManualClock());
  const leaseA = checkoutMust(store, "alice", "A");
  const leaseB = checkoutMust(store, "alice", "B");

  const result = store.save(
    "alice",
    [
      { kind: "create", id: "A", dependsOn: ["B"] },
      { kind: "create", id: "B" },
    ],
    [leaseA, leaseB],
  );
  assert.ok(result.ok);
  assert.deepEqual(store.read().get("A"), { id: "A", dependsOn: ["B"] });
});

test("same-batch delete of component and its incoming edges is allowed", () => {
  const store = new ComponentStore(new ManualClock());
  const leaseA = checkoutMust(store, "alice", "A");
  const leaseB = checkoutMust(store, "alice", "B");
  const created = store.save(
    "alice",
    [
      { kind: "create", id: "A", dependsOn: ["B"] },
      { kind: "create", id: "B" },
    ],
    [leaseA, leaseB],
  );
  assert.ok(created.ok);

  const removed = store.save(
    "alice",
    [
      { kind: "delete", id: "B" },
      { kind: "setDependsOn", id: "A", dependsOn: [] },
    ],
    [leaseA, leaseB],
  );
  assert.ok(removed.ok);
  const graph = store.read();
  assert.ok(!graph.has("B"));
  assert.deepEqual(graph.get("A"), { id: "A", dependsOn: [] });
});

test("dangling reference is rejected and leaves no residue", () => {
  const store = new ComponentStore(new ManualClock());
  const leaseA = checkoutMust(store, "alice", "A");
  const leaseB = checkoutMust(store, "alice", "B");

  const result = store.save(
    "alice",
    [
      { kind: "create", id: "A", dependsOn: ["B"] },
      { kind: "create", id: "B" },
      { kind: "delete", id: "B" },
    ],
    [leaseA, leaseB],
  );
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "dangling-reference");
  assert.equal(store.read().size, 0);
});

test("deleted component's old lease stays invalid after re-creation", () => {
  const store = new ComponentStore(new ManualClock());
  const oldLease = checkoutMust(store, "alice", "X");
  const created = store.save("alice", [{ kind: "create", id: "X" }], [oldLease]);
  assert.ok(created.ok);
  const deleted = store.save("alice", [{ kind: "delete", id: "X" }], [oldLease]);
  assert.ok(deleted.ok);

  const newLease = checkoutMust(store, "bob", "X");
  const recreated = store.save("bob", [{ kind: "create", id: "X" }], [newLease]);
  assert.ok(recreated.ok);

  const stale = store.save(
    "alice",
    [{ kind: "delete", id: "X" }],
    [oldLease],
  );
  assert.ok(!stale.ok);
  assert.ok(store.read().has("X"));
});

test("read returns an isolated copy", () => {
  const store = new ComponentStore(new ManualClock());
  const lease = checkoutMust(store, "alice", "A");
  const saved = store.save("alice", [{ kind: "create", id: "A" }], [lease]);
  assert.ok(saved.ok);

  const snapshot = store.read();
  snapshot.get("A")!.dependsOn.push("EVIL");
  snapshot.delete("A");

  const fresh = store.read();
  assert.deepEqual(fresh.get("A"), { id: "A", dependsOn: [] });
});

test("save requires leases for every modified id", () => {
  const store = new ComponentStore(new ManualClock());
  const leaseA = checkoutMust(store, "alice", "A");
  checkoutMust(store, "alice", "B");

  const result = store.save(
    "alice",
    [
      { kind: "create", id: "A" },
      { kind: "create", id: "B" },
    ],
    [leaseA],
  );
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "no-valid-lease");
  assert.equal(store.read().size, 0);
});
