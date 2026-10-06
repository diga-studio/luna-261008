import { test } from "node:test";
import assert from "node:assert/strict";
import { CallOwnershipService } from "../src/call-ownership";
import { KeyConflictError } from "../src/types";
import { ManualHandoff, mustOpen } from "./helpers";

function setup() {
  const handoff = new ManualHandoff();
  handoff.setMode("success");
  const svc = new CallOwnershipService(handoff.fn);
  return { handoff, svc };
}

test("openCall creates a call and snapshot reflects ownership", async () => {
  const { svc } = setup();
  const callId = mustOpen(await svc.openCall("A", "k1"));
  const snap = svc.snapshot();
  assert.deepEqual(snap.calls, [{ callId, agentId: "A" }]);
  assert.deepEqual(snap.agentCalls, { A: callId });
});

test("openCall fails when agent already holds a call", async () => {
  const { svc } = setup();
  mustOpen(await svc.openCall("A", "k1"));
  const second = await svc.openCall("A", "k2");
  assert.deepEqual(second, { ok: false, error: "AGENT_BUSY" });
});

test("callIds are unique and never reused, even after close", async () => {
  const { svc } = setup();
  const ids = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const callId = mustOpen(await svc.openCall("A", `open-${i}`));
    assert.ok(!ids.has(callId));
    ids.add(callId);
    const closed = await svc.closeCall(callId, "A", `close-${i}`);
    assert.deepEqual(closed, { ok: true });
  }
  assert.equal(ids.size, 5);
});

test("transferCall moves ownership and keeps callId", async () => {
  const { svc, handoff } = setup();
  const callId = mustOpen(await svc.openCall("A", "k1"));
  const moved = await svc.transferCall(callId, "A", "B", "k2");
  assert.deepEqual(moved, { ok: true });
  assert.equal(handoff.invocations.length, 1);
  assert.deepEqual(handoff.invocations[0], {
    callId,
    fromAgentId: "A",
    toAgentId: "B",
  });
  const snap = svc.snapshot();
  assert.deepEqual(snap.calls, [{ callId, agentId: "B" }]);
  assert.deepEqual(snap.agentCalls, { B: callId });
});

test("transferCall validates preconditions", async () => {
  const { svc, handoff } = setup();
  const callId = mustOpen(await svc.openCall("A", "k1"));
  mustOpen(await svc.openCall("B", "k2"));

  assert.deepEqual(await svc.transferCall("nope", "A", "C", "k3"), {
    ok: false,
    error: "CALL_NOT_FOUND",
  });
  assert.deepEqual(await svc.transferCall(callId, "C", "D", "k4"), {
    ok: false,
    error: "NOT_OWNER",
  });
  assert.deepEqual(await svc.transferCall(callId, "A", "A", "k5"), {
    ok: false,
    error: "SAME_AGENT",
  });
  assert.deepEqual(await svc.transferCall(callId, "A", "B", "k6"), {
    ok: false,
    error: "TARGET_BUSY",
  });
  assert.equal(handoff.invocations.length, 0);
});

test("transferCall reports HANDOFF_FAILED and keeps ownership on rejection", async () => {
  const handoff = new ManualHandoff();
  handoff.setMode("fail");
  const svc = new CallOwnershipService(handoff.fn);
  const callId = mustOpen(await svc.openCall("A", "k1"));
  const moved = await svc.transferCall(callId, "A", "B", "k2");
  assert.deepEqual(moved, { ok: false, error: "HANDOFF_FAILED" });
  const snap = svc.snapshot();
  assert.deepEqual(snap.calls, [{ callId, agentId: "A" }]);
  assert.deepEqual(snap.agentCalls, { A: callId });
});

test("closeCall only succeeds for the current owner", async () => {
  const { svc } = setup();
  const callId = mustOpen(await svc.openCall("A", "k1"));
  assert.deepEqual(await svc.closeCall(callId, "B", "k2"), {
    ok: false,
    error: "NOT_OWNER",
  });
  assert.deepEqual(await svc.closeCall("nope", "A", "k3"), {
    ok: false,
    error: "CALL_NOT_FOUND",
  });
  assert.deepEqual(await svc.closeCall(callId, "A", "k4"), { ok: true });
  assert.deepEqual(svc.snapshot().calls, []);
  assert.deepEqual(svc.snapshot().agentCalls, {});
  mustOpen(await svc.openCall("A", "k5"));
});

test("same key with different operation or params throws KeyConflictError", async () => {
  const { svc } = setup();
  await svc.openCall("A", "k1");
  assert.throws(() => svc.openCall("B", "k1"), KeyConflictError);
  assert.throws(() => svc.closeCall("c1", "A", "k1"), KeyConflictError);
  assert.throws(() => svc.transferCall("c1", "A", "B", "k1"), KeyConflictError);
});

test("same key with same op and params replays the original result", async () => {
  const { svc } = setup();
  const first = mustOpen(await svc.openCall("A", "k1"));
  const replay = await svc.openCall("A", "k1");
  assert.deepEqual(replay, { ok: true, callId: first });
});
