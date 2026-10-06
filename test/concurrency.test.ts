import { test } from "node:test";
import assert from "node:assert/strict";
import { CallOwnership } from "../src/call-ownership";
import { ControllableHandoff, wasSettled } from "./helpers";

async function setup() {
  const handoff = new ControllableHandoff();
  const co = new CallOwnership(handoff.fn);
  const c1 = await co.openCall("A", "open-a");
  const c2 = await co.openCall("C", "open-c");
  assert.ok(c1.ok && c2.ok);
  return { handoff, co, c1: c1.callId, c2: c2.callId };
}

test("paused transfer blocks conflicting writes but not independent ones (handoff succeeds)", async () => {
  const { handoff, co, c1, c2 } = await setup();

  const transfer = co.transferCall(c1, "A", "B", "t1");
  await handoff.waitForCallCount(1);

  const close = co.closeCall(c1, "A", "close-1");
  const openB = co.openCall("B", "open-b");
  const independent = co.transferCall(c2, "C", "D", "t2");

  await handoff.waitForCallCount(2);
  handoff.succeed(1);
  const independentResult = await independent;
  assert.deepEqual(independentResult, {
    ok: true,
    callId: c2,
    fromAgentId: "C",
    toAgentId: "D",
  });

  assert.equal(await wasSettled(close), false);
  assert.equal(await wasSettled(openB), false);
  assert.equal(await wasSettled(transfer), false);

  const midSnap = co.snapshot();
  assert.equal(midSnap.calls.get(c1), "A");
  assert.equal(midSnap.agents.get("A"), c1);
  assert.equal(midSnap.agents.has("B"), false);
  assert.equal(midSnap.calls.get(c2), "D");

  handoff.succeed(0);
  assert.deepEqual(await transfer, {
    ok: true,
    callId: c1,
    fromAgentId: "A",
    toAgentId: "B",
  });

  const closeResult = await close;
  assert.equal(closeResult.ok, false);
  if (!closeResult.ok) assert.equal(closeResult.code, "AGENT_NOT_OWNER");

  const openBResult = await openB;
  assert.equal(openBResult.ok, false);
  if (!openBResult.ok) assert.equal(openBResult.code, "AGENT_BUSY");

  const snap = co.snapshot();
  assert.equal(snap.calls.get(c1), "B");
  assert.equal(snap.agents.get("B"), c1);
  assert.equal(snap.calls.get(c2), "D");
  assert.equal(snap.agents.get("D"), c2);
  assert.equal(snap.agents.has("A"), false);
  assert.equal(snap.agents.has("C"), false);
  assert.equal(snap.calls.size, 2);
  assert.equal(snap.agents.size, 2);
});

test("paused transfer blocks conflicting writes but not independent ones (handoff fails)", async () => {
  const { handoff, co, c1, c2 } = await setup();

  const transfer = co.transferCall(c1, "A", "B", "t1");
  await handoff.waitForCallCount(1);

  const close = co.closeCall(c1, "A", "close-1");
  const openB = co.openCall("B", "open-b");
  const independent = co.transferCall(c2, "C", "D", "t2");

  await handoff.waitForCallCount(2);
  handoff.succeed(1);
  const independentResult = await independent;
  assert.equal(independentResult.ok, true);

  assert.equal(await wasSettled(close), false);
  assert.equal(await wasSettled(openB), false);

  const midSnap = co.snapshot();
  assert.equal(midSnap.calls.get(c1), "A");
  assert.equal(midSnap.agents.get("A"), c1);

  handoff.fail(0, new Error("simulated handoff failure"));
  const transferResult = await transfer;
  assert.equal(transferResult.ok, false);
  if (!transferResult.ok) assert.equal(transferResult.code, "HANDOFF_FAILED");

  const closeResult = await close;
  assert.deepEqual(closeResult, { ok: true, callId: c1 });

  const openBResult = await openB;
  assert.equal(openBResult.ok, true);
  if (openBResult.ok) assert.notEqual(openBResult.callId, c1);

  const snap = co.snapshot();
  assert.equal(snap.calls.has(c1), false);
  assert.equal(snap.agents.has("A"), false);
  assert.ok(openBResult.ok);
  if (openBResult.ok) {
    assert.equal(snap.calls.get(openBResult.callId), "B");
    assert.equal(snap.agents.get("B"), openBResult.callId);
  }
  assert.equal(snap.calls.get(c2), "D");
  assert.equal(snap.agents.get("D"), c2);
  assert.equal(snap.calls.size, 2);
  assert.equal(snap.agents.size, 2);
});
