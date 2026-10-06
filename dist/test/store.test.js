"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const store_1 = require("../src/store");
const clock_1 = require("../src/clock");
function checkoutMust(store, actor, id) {
    const result = store.checkout(actor, id);
    strict_1.default.ok(result.ok, `checkout ${id} by ${actor} should succeed`);
    return result.lease;
}
(0, node_test_1.test)("cycle: A->B and B->A committed separately, exactly one succeeds", () => {
    const store = new store_1.ComponentStore(new clock_1.ManualClock());
    const leaseA = checkoutMust(store, "alice", "A");
    const leaseB = checkoutMust(store, "alice", "B");
    const created = store.save("alice", [
        { kind: "create", id: "A" },
        { kind: "create", id: "B" },
    ], [leaseA, leaseB]);
    strict_1.default.ok(created.ok);
    const ab = store.save("alice", [{ kind: "setDependsOn", id: "A", dependsOn: ["B"] }], [leaseA]);
    strict_1.default.ok(ab.ok);
    const ba = store.save("alice", [{ kind: "setDependsOn", id: "B", dependsOn: ["A"] }], [leaseB]);
    strict_1.default.ok(!ba.ok);
    if (!ba.ok)
        strict_1.default.equal(ba.error.code, "cycle");
    const graph = store.read();
    strict_1.default.deepEqual(graph.get("A"), { id: "A", dependsOn: ["B"] });
    strict_1.default.deepEqual(graph.get("B"), { id: "B", dependsOn: [] });
});
(0, node_test_1.test)("expiry: re-checkout after expiry, old lease cannot save or overwrite", () => {
    const clock = new clock_1.ManualClock();
    const store = new store_1.ComponentStore(clock);
    const oldLease = checkoutMust(store, "alice", "X");
    clock.advance(store_1.LEASE_TTL_MS + 1);
    const blocked = store.save("alice", [{ kind: "create", id: "X" }], [oldLease]);
    strict_1.default.ok(!blocked.ok);
    if (!blocked.ok)
        strict_1.default.equal(blocked.error.code, "no-valid-lease");
    const newLease = checkoutMust(store, "bob", "X");
    strict_1.default.ok(newLease.token !== oldLease.token);
    const saved = store.save("bob", [{ kind: "create", id: "X", dependsOn: [] }], [newLease]);
    strict_1.default.ok(saved.ok);
    const stale = store.save("alice", [{ kind: "setDependsOn", id: "X", dependsOn: [] }], [oldLease]);
    strict_1.default.ok(!stale.ok);
    if (!stale.ok)
        strict_1.default.equal(stale.error.code, "no-valid-lease");
    const aliceCheckout = store.checkout("alice", "X");
    strict_1.default.ok(!aliceCheckout.ok);
    if (!aliceCheckout.ok)
        strict_1.default.equal(aliceCheckout.holder, "bob");
    const graph = store.read();
    strict_1.default.deepEqual(graph.get("X"), { id: "X", dependsOn: [] });
});
(0, node_test_1.test)("failed save does not renew the lease", () => {
    const clock = new clock_1.ManualClock();
    const store = new store_1.ComponentStore(clock);
    const lease = checkoutMust(store, "alice", "X");
    clock.advance(store_1.LEASE_TTL_MS - 1);
    const failed = store.save("alice", [{ kind: "create", id: "X", dependsOn: ["MISSING"] }], [lease]);
    strict_1.default.ok(!failed.ok);
    clock.advance(2);
    const late = store.save("alice", [{ kind: "create", id: "X" }], [lease]);
    strict_1.default.ok(!late.ok);
    if (!late.ok)
        strict_1.default.equal(late.error.code, "no-valid-lease");
});
(0, node_test_1.test)("successful save renews the lease", () => {
    const clock = new clock_1.ManualClock();
    const store = new store_1.ComponentStore(clock);
    const lease = checkoutMust(store, "alice", "X");
    clock.advance(store_1.LEASE_TTL_MS - 1);
    const saved = store.save("alice", [{ kind: "create", id: "X" }], [lease]);
    strict_1.default.ok(saved.ok);
    clock.advance(store_1.LEASE_TTL_MS - 1);
    const stillValid = store.save("alice", [{ kind: "setDependsOn", id: "X", dependsOn: [] }], [lease]);
    strict_1.default.ok(stillValid.ok);
});
(0, node_test_1.test)("same actor re-checkout renews; other actor is rejected while valid", () => {
    const clock = new clock_1.ManualClock();
    const store = new store_1.ComponentStore(clock);
    const first = checkoutMust(store, "alice", "X");
    clock.advance(store_1.LEASE_TTL_MS - 1);
    const second = checkoutMust(store, "alice", "X");
    strict_1.default.ok(second.expiresAt > first.expiresAt);
    const denied = store.checkout("bob", "X");
    strict_1.default.ok(!denied.ok);
    if (!denied.ok)
        strict_1.default.equal(denied.holder, "alice");
    clock.advance(store_1.LEASE_TTL_MS - 1);
    const stillDenied = store.checkout("bob", "X");
    strict_1.default.ok(!stillDenied.ok);
});
(0, node_test_1.test)("same-batch create and reference is allowed", () => {
    const store = new store_1.ComponentStore(new clock_1.ManualClock());
    const leaseA = checkoutMust(store, "alice", "A");
    const leaseB = checkoutMust(store, "alice", "B");
    const result = store.save("alice", [
        { kind: "create", id: "A", dependsOn: ["B"] },
        { kind: "create", id: "B" },
    ], [leaseA, leaseB]);
    strict_1.default.ok(result.ok);
    strict_1.default.deepEqual(store.read().get("A"), { id: "A", dependsOn: ["B"] });
});
(0, node_test_1.test)("same-batch delete of component and its incoming edges is allowed", () => {
    const store = new store_1.ComponentStore(new clock_1.ManualClock());
    const leaseA = checkoutMust(store, "alice", "A");
    const leaseB = checkoutMust(store, "alice", "B");
    const created = store.save("alice", [
        { kind: "create", id: "A", dependsOn: ["B"] },
        { kind: "create", id: "B" },
    ], [leaseA, leaseB]);
    strict_1.default.ok(created.ok);
    const removed = store.save("alice", [
        { kind: "delete", id: "B" },
        { kind: "setDependsOn", id: "A", dependsOn: [] },
    ], [leaseA, leaseB]);
    strict_1.default.ok(removed.ok);
    const graph = store.read();
    strict_1.default.ok(!graph.has("B"));
    strict_1.default.deepEqual(graph.get("A"), { id: "A", dependsOn: [] });
});
(0, node_test_1.test)("dangling reference is rejected and leaves no residue", () => {
    const store = new store_1.ComponentStore(new clock_1.ManualClock());
    const leaseA = checkoutMust(store, "alice", "A");
    const leaseB = checkoutMust(store, "alice", "B");
    const result = store.save("alice", [
        { kind: "create", id: "A", dependsOn: ["B"] },
        { kind: "create", id: "B" },
        { kind: "delete", id: "B" },
    ], [leaseA, leaseB]);
    strict_1.default.ok(!result.ok);
    if (!result.ok)
        strict_1.default.equal(result.error.code, "dangling-reference");
    strict_1.default.equal(store.read().size, 0);
});
(0, node_test_1.test)("deleted component's old lease stays invalid after re-creation", () => {
    const store = new store_1.ComponentStore(new clock_1.ManualClock());
    const oldLease = checkoutMust(store, "alice", "X");
    const created = store.save("alice", [{ kind: "create", id: "X" }], [oldLease]);
    strict_1.default.ok(created.ok);
    const deleted = store.save("alice", [{ kind: "delete", id: "X" }], [oldLease]);
    strict_1.default.ok(deleted.ok);
    const newLease = checkoutMust(store, "bob", "X");
    const recreated = store.save("bob", [{ kind: "create", id: "X" }], [newLease]);
    strict_1.default.ok(recreated.ok);
    const stale = store.save("alice", [{ kind: "delete", id: "X" }], [oldLease]);
    strict_1.default.ok(!stale.ok);
    strict_1.default.ok(store.read().has("X"));
});
(0, node_test_1.test)("read returns an isolated copy", () => {
    const store = new store_1.ComponentStore(new clock_1.ManualClock());
    const lease = checkoutMust(store, "alice", "A");
    const saved = store.save("alice", [{ kind: "create", id: "A" }], [lease]);
    strict_1.default.ok(saved.ok);
    const snapshot = store.read();
    snapshot.get("A").dependsOn.push("EVIL");
    snapshot.delete("A");
    const fresh = store.read();
    strict_1.default.deepEqual(fresh.get("A"), { id: "A", dependsOn: [] });
});
(0, node_test_1.test)("save requires leases for every modified id", () => {
    const store = new store_1.ComponentStore(new clock_1.ManualClock());
    const leaseA = checkoutMust(store, "alice", "A");
    checkoutMust(store, "alice", "B");
    const result = store.save("alice", [
        { kind: "create", id: "A" },
        { kind: "create", id: "B" },
    ], [leaseA]);
    strict_1.default.ok(!result.ok);
    if (!result.ok)
        strict_1.default.equal(result.error.code, "no-valid-lease");
    strict_1.default.equal(store.read().size, 0);
});
