import { test } from "node:test";
import assert from "node:assert/strict";
import { CallOwnership } from "../src/call-ownership";
import { ControllableHandoff } from "./helpers";

function immediateHandoff(): () => Promise<void> {
  return () => Promise.resolve();
}

test("openCall creates a call for an idle agent and rejects a second one", async () => {
  const co = new CallOwnership(immediateHandoff());
  const first = await co.openCall("A", "k1");
  assert.deepEqual(first, { ok: true, callId: "call-1" });

  const second = await co.openCall("A", "k2");
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "AGENT_BUSY");

  const snap = co.snapshot();
  assert.equal(snap.calls.get("call-1"), "A");
  assert.equal(snap.agents.get("A"), "call-1");
});

test("callIds are unique and never reused", async () => {
  const co = new CallOwnership(immediateHandoff());
  const a = await co.openCall("A", "k1");
  const b = await co.openCall("B", "k2");
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.callId, b.callId);

  await co.closeCall(a.callId, "A", "k3");
  const c = await co.openCall("A", "k4");
  assert.ok(c.ok);
  assert.notEqual(c.callId, a.callId);
  assert.notEqual(c.callId, b.callId);
});

test("transferCall moves ownership and keeps the callId", async () => {
  const co = new CallOwnership(immediateHandoff());
  const opened = await co.openCall("A", "k1");
  assert.ok(opened.ok);

  const moved = await co.transferCall(opened.callId, "A", "B", "k2");
  assert.deepEqual(moved, {
    ok: true,
    callId: opened.callId,
    fromAgentId: "A",
    toAgentId: "B",
  });

  const snap = co.snapshot();
  assert.equal(snap.calls.get(opened.callId), "B");
  assert.equal(snap.agents.get("B"), opened.callId);
  assert.equal(snap.agents.has("A"), false);
});

test("transferCall validates source owner and target availability", async () => {
  const co = new CallOwnership(immediateHandoff());
  const c1 = await co.openCall("A", "k1");
  const c2 = await co.openCall("B", "k2");
  assert.ok(c1.ok && c2.ok);

  const notOwner = await co.transferCall(c1.callId, "C", "D", "k3");
  assert.equal(notOwner.ok, false);
  if (!notOwner.ok) assert.equal(notOwner.code, "AGENT_NOT_OWNER");

  const busyTarget = await co.transferCall(c1.callId, "A", "B", "k4");
  assert.equal(busyTarget.ok, false);
  if (!busyTarget.ok) assert.equal(busyTarget.code, "TARGET_BUSY");

  const sameAgent = await co.transferCall(c1.callId, "A", "A", "k5");
  assert.equal(sameAgent.ok, false);
  if (!sameAgent.ok) assert.equal(sameAgent.code, "TARGET_SAME_AS_SOURCE");

  const missing = await co.transferCall("nope", "A", "D", "k6");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "CALL_NOT_FOUND");

  const snap = co.snapshot();
  assert.equal(snap.calls.get(c1.callId), "A");
  assert.equal(snap.calls.get(c2.callId), "B");
});

test("closeCall only succeeds for the current owner", async () => {
  const co = new CallOwnership(immediateHandoff());
  const opened = await co.openCall("A", "k1");
  assert.ok(opened.ok);

  const wrong = await co.closeCall(opened.callId, "B", "k2");
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.code, "AGENT_NOT_OWNER");

  const closed = await co.closeCall(opened.callId, "A", "k3");
  assert.deepEqual(closed, { ok: true, callId: opened.callId });

  const again = await co.closeCall(opened.callId, "A", "k4");
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "CALL_NOT_FOUND");

  const snap = co.snapshot();
  assert.equal(snap.calls.size, 0);
  assert.equal(snap.agents.size, 0);
});

test("snapshot is consistent and isolated from later mutations", async () => {
  const co = new CallOwnership(immediateHandoff());
  const c1 = await co.openCall("A", "k1");
  assert.ok(c1.ok);
  const before = co.snapshot();
  await co.transferCall(c1.callId, "A", "B", "k2");

  assert.equal(before.calls.get(c1.callId), "A");
  assert.equal(before.agents.get("A"), c1.callId);
  assert.equal(before.agents.has("B"), false);

  const after = co.snapshot();
  assert.equal(after.calls.get(c1.callId), "B");
  for (const [callId, agentId] of after.calls) {
    assert.equal(after.agents.get(agentId), callId);
  }
});

test("failed handoff keeps the original ownership", async () => {
  const handoff = new ControllableHandoff();
  const co = new CallOwnership(handoff.fn);
  const opened = await co.openCall("A", "k1");
  assert.ok(opened.ok);

  const moved = co.transferCall(opened.callId, "A", "B", "k2");
  await handoff.waitForCallCount(1);
  handoff.fail(0, new Error("boom"));

  const result = await moved;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "HANDOFF_FAILED");

  const snap = co.snapshot();
  assert.equal(snap.calls.get(opened.callId), "A");
  assert.equal(snap.agents.get("A"), opened.callId);
  assert.equal(snap.agents.has("B"), false);
});

test("same key with different operation or parameters reports a conflict", async () => {
  const co = new CallOwnership(immediateHandoff());
  await co.openCall("A", "k1");

  const differentOp = await co.closeCall("call-1", "A", "k1");
  assert.equal(differentOp.ok, false);
  if (!differentOp.ok) assert.equal(differentOp.code, "KEY_CONFLICT");

  const differentParams = await co.openCall("B", "k1");
  assert.equal(differentParams.ok, false);
  if (!differentParams.ok) assert.equal(differentParams.code, "KEY_CONFLICT");

  const snap = co.snapshot();
  assert.equal(snap.calls.get("call-1"), "A");
  assert.equal(snap.agents.has("B"), false);
});

test("completed operations replay their original result under the same key", async () => {
  const co = new CallOwnership(immediateHandoff());
  const first = await co.openCall("A", "k1");
  const replay = await co.openCall("A", "k1");
  assert.deepEqual(replay, first);

  const busyReplay = await co.openCall("A", "k2");
  assert.equal(busyReplay.ok, false);
  const busyAgain = await co.openCall("A", "k2");
  assert.deepEqual(busyAgain, busyReplay);
});
