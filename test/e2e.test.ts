import test from "node:test";
import assert from "node:assert/strict";
import { AgentSide } from "../src/agent";
import { SummarySide } from "../src/summary";
import { makeBody, tempDir } from "./helpers";

test("two agents interleaved: gap blocks exposure, acks stay independent", () => {
  const dir = tempDir();
  const agentADb = dir.file("agent-a.db");
  const agentBDb = dir.file("agent-b.db");
  const summaryDb = dir.file("summary.db");
  try {
    // Both agents receive events locally while "offline".
    const agentA = new AgentSide(agentADb);
    const agentB = new AgentSide(agentBDb);
    const aBodies = [makeBody(101), makeBody(102), makeBody(103)];
    const bBodies = [makeBody(201), makeBody(202), makeBody(203), makeBody(204)];
    aBodies.forEach((b, i) => agentA.receiveEvent(`a-${i + 1}`, b));
    bBodies.forEach((b, i) => agentB.receiveEvent(`b-${i + 1}`, b));

    const summary = new SummarySide(summaryDb);

    // Agent B's later events arrive first (partial, out of order).
    const bPending = agentB.pendingEvents();
    const wmB1 = summary.ingest("agent-b", bPending.slice(2)); // seqs 3,4
    assert.equal(wmB1, 0);
    assert.deepEqual(summary.records("agent-b"), []);

    // Agent A transmits fully and gets its receipt; B stays blocked.
    const wmA1 = summary.ingest("agent-a", agentA.pendingEvents());
    assert.equal(wmA1, 3);
    agentA.applyAck(wmA1);
    assert.equal(agentA.confirmedWatermark(), 3);
    assert.deepEqual(agentA.pendingEvents(), []);
    assert.equal(summary.watermark("agent-b"), 0);
    assert.deepEqual(summary.records("agent-b"), []);

    // B's gap is finally filled by retransmission of the early events.
    const wmB2 = summary.ingest("agent-b", bPending.slice(0, 2)); // seqs 1,2
    assert.equal(wmB2, 4);

    // Both sides restart independently; state must be fully recoverable.
    agentA.close();
    agentB.close();
    summary.close();

    const agentA2 = new AgentSide(agentADb);
    const agentB2 = new AgentSide(agentBDb);
    const summary2 = new SummarySide(summaryDb);

    assert.equal(summary2.watermark("agent-a"), 3);
    assert.equal(summary2.watermark("agent-b"), 4);
    assert.equal(agentA2.confirmedWatermark(), 3);

    // Public records match the received events byte-for-byte, in seq order.
    const recsA = summary2.records("agent-a");
    const recsB = summary2.records("agent-b");
    assert.deepEqual(recsA.map((r) => r.seq), [1, 2, 3]);
    assert.deepEqual(recsB.map((r) => r.seq), [1, 2, 3, 4]);
    recsA.forEach((r, i) => assert.deepEqual([...r.body], [...aBodies[i]]));
    recsB.forEach((r, i) => assert.deepEqual([...r.body], [...bBodies[i]]));

    // B gets its receipt after restart; cleanup works; resubmission of a
    // cleaned event id is recognized and adds nothing anywhere.
    agentB2.applyAck(summary2.watermark("agent-b"));
    assert.equal(agentB2.pendingEvents().length, 0);
    const resub = agentB2.receiveEvent("b-1", bBodies[0]);
    assert.deepEqual(resub, { seq: 1, created: false });
    assert.equal(agentB2.pendingEvents().length, 0);
    summary2.ingest("agent-b", agentB2.pendingEvents());
    assert.equal(summary2.records("agent-b").length, 4);

    agentA2.close();
    agentB2.close();
    summary2.close();
  } finally {
    dir.cleanup();
  }
});
