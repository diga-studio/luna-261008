import { test } from "node:test";
import assert from "node:assert/strict";
import { CallOwnershipService } from "../src/call-ownership";
import { ManualHandoff, flush, mustOpen, track } from "./helpers";

async function setupPausedTransfer() {
  const handoff = new ManualHandoff();
  const svc = new CallOwnershipService(handoff.fn);
  const callAB = mustOpen(await svc.openCall("A", "open-a"));
  const callCD = mustOpen(await svc.openCall("C", "open-c"));
  const firstHandoff = handoff.nextInvocation();
  const transfer = track(svc.transferCall(callAB, "A", "B", "transfer-ab"));
  await firstHandoff;
  handoff.setMode("success");
  await flush();
  return { handoff, svc, callAB, callCD, transfer };
}

test("conflicting writes wait for paused handoff, independent transfer completes", async () => {
  const { handoff, svc, callAB, callCD, transfer } = await setupPausedTransfer();

  const close = track(svc.closeCall(callAB, "A", "close-ab"));
  const openB = track(svc.openCall("B", "open-b"));
  const transferCD = track(svc.transferCall(callCD, "C", "D", "transfer-cd"));
  await flush();

  assert.equal(close.settled(), false, "close on in-flight call must wait");
  assert.equal(openB.settled(), false, "open on in-flight target agent must wait");
  assert.equal(transferCD.settled(), true, "independent transfer must complete");
  assert.deepEqual(await transferCD.result, { ok: true });

  const snap = svc.snapshot();
  assert.deepEqual(
    snap.calls.slice().sort((x, y) => x.callId.localeCompare(y.callId)),
    [
      { callId: callAB, agentId: "A" },
      { callId: callCD, agentId: "D" },
    ],
    "snapshot must show pre-transfer ownership while handoff is paused"
  );
  assert.deepEqual(snap.agentCalls, { A: callAB, D: callCD });

  handoff.releaseAll();
  assert.deepEqual(await transfer.result, { ok: true });
  assert.deepEqual(await close.result, { ok: false, error: "NOT_OWNER" });
  assert.deepEqual(await openB.result, { ok: false, error: "AGENT_BUSY" });

  const finalSnap = svc.snapshot();
  assert.deepEqual(finalSnap.agentCalls, { B: callAB, D: callCD });
  assert.equal(finalSnap.calls.length, 2);
});

test("failed handoff unblocks waiting writes against unchanged ownership", async () => {
  const { handoff, svc, callAB, callCD, transfer } = await setupPausedTransfer();

  const close = track(svc.closeCall(callAB, "A", "close-ab"));
  const openB = track(svc.openCall("B", "open-b"));
  const transferCD = track(svc.transferCall(callCD, "C", "D", "transfer-cd"));
  await flush();

  assert.equal(close.settled(), false);
  assert.equal(openB.settled(), false);
  assert.equal(transferCD.settled(), true);
  assert.deepEqual(svc.snapshot().agentCalls, { A: callAB, D: callCD });

  handoff.failAll();
  assert.deepEqual(await transfer.result, { ok: false, error: "HANDOFF_FAILED" });
  assert.deepEqual(await close.result, { ok: true });
  const newCallB = mustOpen(await openB.result);

  const finalSnap = svc.snapshot();
  assert.deepEqual(finalSnap.agentCalls, { B: newCallB, D: callCD });
  assert.equal(finalSnap.calls.length, 2);
  assert.ok(!finalSnap.calls.some((c) => c.callId === callAB));
});

test("writes on either endpoint agent of a paused transfer wait", async () => {
  const { handoff, svc, callAB, transfer } = await setupPausedTransfer();

  const openA = track(svc.openCall("A", "open-a2"));
  const transferToB = track(svc.transferCall(callAB, "A", "B", "transfer-ab2"));
  await flush();
  assert.equal(openA.settled(), false);
  assert.equal(transferToB.settled(), false);

  handoff.releaseAll();
  assert.deepEqual(await transfer.result, { ok: true });
  const newCallA = mustOpen(await openA.result);
  assert.deepEqual(await transferToB.result, { ok: false, error: "NOT_OWNER" });

  const snap = svc.snapshot();
  assert.equal(snap.agentCalls["B"], callAB);
  assert.equal(snap.agentCalls["A"], newCallA);
  assert.equal(Object.keys(snap.agentCalls).length, 3);
});
