import { test } from "node:test";
import assert from "node:assert/strict";
import { CallOwnership } from "../src/call-ownership";
import { ControllableHandoff, wasSettled } from "./helpers";

test("duplicate keys attach to the in-flight transfer; conflicts are rejected; replay never re-executes (handoff succeeds)", async () => {
  const handoff = new ControllableHandoff();
  const co = new CallOwnership(handoff.fn);
  const opened = await co.openCall("A", "open-a");
  assert.ok(opened.ok);
  const c1 = opened.callId;

  const first = co.transferCall(c1, "A", "B", "k-t");
  await handoff.waitForCallCount(1);

  const dup1 = co.transferCall(c1, "A", "B", "k-t");
  const dup2 = co.transferCall(c1, "A", "B", "k-t");
  assert.equal(dup1, first);
  assert.equal(dup2, first);

  const conflictTransfer = await co.transferCall(c1, "A", "C", "k-t");
  assert.equal(conflictTransfer.ok, false);
  if (!conflictTransfer.ok) assert.equal(conflictTransfer.code, "KEY_CONFLICT");

  const conflictOpen = await co.openCall("Z", "k-t");
  assert.equal(conflictOpen.ok, false);
  if (!conflictOpen.ok) assert.equal(conflictOpen.code, "KEY_CONFLICT");

  const conflictClose = await co.closeCall(c1, "A", "k-t");
  assert.equal(conflictClose.ok, false);
  if (!conflictClose.ok) assert.equal(conflictClose.code, "KEY_CONFLICT");

  assert.equal(await wasSettled(first), false);
  assert.equal(handoff.callCount, 1);

  handoff.succeed(0);
  const result = await first;
  assert.deepEqual(result, {
    ok: true,
    callId: c1,
    fromAgentId: "A",
    toAgentId: "B",
  });
  assert.deepEqual(await dup1, result);
  assert.deepEqual(await dup2, result);
  assert.equal(handoff.callCount, 1);

  const closed = await co.closeCall(c1, "B", "close-1");
  assert.deepEqual(closed, { ok: true, callId: c1 });

  const reopened = await co.openCall("A", "open-a2");
  assert.ok(reopened.ok);
  const c3 = reopened.callId;
  assert.notEqual(c3, c1);

  const replay = await co.transferCall(c1, "A", "B", "k-t");
  assert.deepEqual(replay, result);
  assert.equal(handoff.callCount, 1);

  const stillConflict = await co.transferCall(c1, "A", "C", "k-t");
  assert.equal(stillConflict.ok, false);
  if (!stillConflict.ok) assert.equal(stillConflict.code, "KEY_CONFLICT");

  const snap = co.snapshot();
  assert.equal(snap.calls.has(c1), false);
  assert.equal(snap.calls.get(c3), "A");
  assert.equal(snap.agents.get("A"), c3);
  assert.equal(snap.agents.has("B"), false);
  assert.equal(snap.calls.size, 1);
  assert.equal(snap.agents.size, 1);
});

test("duplicate keys attach to the in-flight transfer; conflicts are rejected; replay never re-executes (handoff fails)", async () => {
  const handoff = new ControllableHandoff();
  const co = new CallOwnership(handoff.fn);
  const opened = await co.openCall("A", "open-a");
  assert.ok(opened.ok);
  const c1 = opened.callId;

  const first = co.transferCall(c1, "A", "B", "k-t");
  await handoff.waitForCallCount(1);

  const dup1 = co.transferCall(c1, "A", "B", "k-t");
  const dup2 = co.transferCall(c1, "A", "B", "k-t");
  assert.equal(dup1, first);
  assert.equal(dup2, first);

  const conflict = await co.transferCall(c1, "A", "C", "k-t");
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "KEY_CONFLICT");

  assert.equal(await wasSettled(first), false);
  assert.equal(handoff.callCount, 1);

  handoff.fail(0, new Error("simulated handoff failure"));
  const result = await first;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "HANDOFF_FAILED");
  assert.deepEqual(await dup1, result);
  assert.deepEqual(await dup2, result);
  assert.equal(handoff.callCount, 1);

  const closed = await co.closeCall(c1, "A", "close-1");
  assert.deepEqual(closed, { ok: true, callId: c1 });

  const reopened = await co.openCall("A", "open-a2");
  assert.ok(reopened.ok);
  const c3 = reopened.callId;

  const replay = await co.transferCall(c1, "A", "B", "k-t");
  assert.deepEqual(replay, result);
  assert.equal(handoff.callCount, 1);

  const snap = co.snapshot();
  assert.equal(snap.calls.has(c1), false);
  assert.equal(snap.calls.get(c3), "A");
  assert.equal(snap.agents.get("A"), c3);
  assert.equal(snap.calls.size, 1);
  assert.equal(snap.agents.size, 1);
});

test("failed business results are replayed under the same key", async () => {
  const handoff = new ControllableHandoff();
  const co = new CallOwnership(handoff.fn);
  const opened = await co.openCall("A", "open-a");
  assert.ok(opened.ok);

  const busy = await co.openCall("A", "open-again");
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.code, "AGENT_BUSY");

  await co.closeCall(opened.callId, "A", "close-1");
  const replay = await co.openCall("A", "open-again");
  assert.deepEqual(replay, busy);

  const snap = co.snapshot();
  assert.equal(snap.calls.size, 0);
  assert.equal(snap.agents.size, 0);
});
