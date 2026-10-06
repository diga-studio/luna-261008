import { test } from "node:test";
import assert from "node:assert/strict";
import { CallOwnershipService } from "../src/call-ownership";
import { KeyConflictError } from "../src/types";
import { ManualHandoff, flush, mustOpen, track } from "./helpers";

test("duplicate keys share one execution; conflicting key is rejected immediately", async () => {
  const handoff = new ManualHandoff();
  const svc = new CallOwnershipService(handoff.fn);
  const callId = mustOpen(await svc.openCall("A", "open-a"));

  const firstHandoff = handoff.nextInvocation();
  const dup1 = track(svc.transferCall(callId, "A", "B", "xfer"));
  await firstHandoff;
  const dup2 = track(svc.transferCall(callId, "A", "B", "xfer"));
  const dup3 = track(svc.transferCall(callId, "A", "B", "xfer"));
  assert.throws(
    () => svc.transferCall(callId, "A", "C", "xfer"),
    KeyConflictError,
    "same key with different params must conflict immediately"
  );
  assert.throws(() => svc.closeCall(callId, "A", "xfer"), KeyConflictError);
  await flush();

  assert.equal(dup1.settled(), false, "duplicates wait for the in-flight execution");
  assert.equal(handoff.invocations.length, 1, "handoff runs exactly once");

  handoff.releaseAll();
  const expected = { ok: true };
  assert.deepEqual(await dup1.result, expected);
  assert.deepEqual(await dup2.result, expected);
  assert.deepEqual(await dup3.result, expected);
  assert.equal(handoff.invocations.length, 1);
  assert.equal(svc.snapshot().agentCalls["B"], callId);
});

test("replay after close and re-open returns original result without re-executing", async () => {
  const handoff = new ManualHandoff();
  handoff.setMode("success");
  const svc = new CallOwnershipService(handoff.fn);
  const callId = mustOpen(await svc.openCall("A", "open-a"));
  assert.deepEqual(await svc.transferCall(callId, "A", "B", "xfer"), { ok: true });
  assert.equal(handoff.invocations.length, 1);

  assert.deepEqual(await svc.closeCall(callId, "B", "close-b"), { ok: true });
  const newCallA = mustOpen(await svc.openCall("A", "open-a2"));
  assert.notEqual(newCallA, callId);

  const replay = await svc.transferCall(callId, "A", "B", "xfer");
  assert.deepEqual(replay, { ok: true }, "replay returns the original result");
  assert.equal(handoff.invocations.length, 1, "replay must not re-run handoff");

  const snap = svc.snapshot();
  assert.deepEqual(snap.agentCalls, { A: newCallA }, "new call is unaffected");
  assert.deepEqual(snap.calls, [{ callId: newCallA, agentId: "A" }]);
});

test("replay of failed handoff returns the failure without re-executing", async () => {
  const handoff = new ManualHandoff();
  const svc = new CallOwnershipService(handoff.fn);
  const callId = mustOpen(await svc.openCall("A", "open-a"));

  const firstHandoff = handoff.nextInvocation();
  const dup1 = track(svc.transferCall(callId, "A", "B", "xfer"));
  await firstHandoff;
  const dup2 = track(svc.transferCall(callId, "A", "B", "xfer"));
  await flush();
  assert.equal(handoff.invocations.length, 1);

  handoff.failAll();
  const failure = { ok: false, error: "HANDOFF_FAILED" };
  assert.deepEqual(await dup1.result, failure);
  assert.deepEqual(await dup2.result, failure);

  assert.deepEqual(await svc.closeCall(callId, "A", "close-a"), { ok: true });
  const newCallA = mustOpen(await svc.openCall("A", "open-a2"));

  const replay = await svc.transferCall(callId, "A", "B", "xfer");
  assert.deepEqual(replay, failure, "replay returns the original failure");
  assert.equal(handoff.invocations.length, 1, "replay must not re-run handoff");
  assert.deepEqual(svc.snapshot().agentCalls, { A: newCallA });
});

test("replay of business failure does not re-check preconditions", async () => {
  const handoff = new ManualHandoff();
  handoff.setMode("success");
  const svc = new CallOwnershipService(handoff.fn);
  mustOpen(await svc.openCall("A", "open-a"));

  const busy = await svc.openCall("A", "open-again");
  assert.deepEqual(busy, { ok: false, error: "AGENT_BUSY" });
  assert.deepEqual(await svc.closeCall(mustOpen(await svc.openCall("B", "open-b")), "B", "close-b"), {
    ok: true,
  });

  const replay = await svc.openCall("A", "open-again");
  assert.deepEqual(replay, busy, "replay returns the original business failure");
  assert.equal(svc.snapshot().agentCalls["A"], svc.snapshot().calls[0]?.callId);
  assert.equal(svc.snapshot().calls.length, 1);
});
