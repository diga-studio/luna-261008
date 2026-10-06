import test from "node:test";
import assert from "node:assert/strict";
import { AgentSide } from "../src/agent";
import { makeBody, tempDir } from "./helpers";

test("receive assigns contiguous seqs from 1 and is idempotent", () => {
  const dir = tempDir();
  try {
    const agent = new AgentSide(dir.file("agent.db"));
    const r1 = agent.receiveEvent("e1", makeBody(1));
    const r2 = agent.receiveEvent("e2", makeBody(2));
    assert.deepEqual(r1, { seq: 1, created: true });
    assert.deepEqual(r2, { seq: 2, created: true });
    const retry = agent.receiveEvent("e1", makeBody(1));
    assert.deepEqual(retry, { seq: 1, created: false });
    const r3 = agent.receiveEvent("e3", makeBody(3));
    assert.equal(r3.seq, 3);
    agent.close();
  } finally {
    dir.cleanup();
  }
});

test("received events and seqs survive restart", () => {
  const dir = tempDir();
  const db = dir.file("agent.db");
  try {
    let agent = new AgentSide(db);
    agent.receiveEvent("e1", makeBody(1));
    agent.receiveEvent("e2", makeBody(2));
    agent.close();

    agent = new AgentSide(db);
    assert.equal(agent.receiveEvent("e1", makeBody(1)).seq, 1);
    assert.equal(agent.receiveEvent("e2", makeBody(2)).seq, 2);
    assert.equal(agent.receiveEvent("e3", makeBody(3)).seq, 3);
    const pending = agent.pendingEvents();
    assert.deepEqual(pending.map((p) => p.seq), [1, 2, 3]);
    assert.deepEqual(pending.map((p) => p.eventId), ["e1", "e2", "e3"]);
    assert.deepEqual([...pending[1].body], [...makeBody(2)]);
    agent.close();
  } finally {
    dir.cleanup();
  }
});

test("ack is monotonic and cleans only confirmed bodies", () => {
  const dir = tempDir();
  try {
    const agent = new AgentSide(dir.file("agent.db"));
    for (let i = 1; i <= 5; i++) agent.receiveEvent(`e${i}`, makeBody(i));
    agent.applyAck(3);
    assert.equal(agent.confirmedWatermark(), 3);
    assert.deepEqual(agent.pendingEvents().map((p) => p.seq), [4, 5]);

    // Stale ack must not regress.
    agent.applyAck(2);
    assert.equal(agent.confirmedWatermark(), 3);
    assert.deepEqual(agent.pendingEvents().map((p) => p.seq), [4, 5]);

    // Late higher ack still advances.
    agent.applyAck(4);
    assert.equal(agent.confirmedWatermark(), 4);
    assert.deepEqual(agent.pendingEvents().map((p) => p.seq), [5]);
    agent.close();
  } finally {
    dir.cleanup();
  }
});

test("cleaned event id still resolves to original seq and is not retransmitted", () => {
  const dir = tempDir();
  const db = dir.file("agent.db");
  try {
    let agent = new AgentSide(db);
    agent.receiveEvent("e1", makeBody(1));
    agent.receiveEvent("e2", makeBody(2));
    agent.applyAck(2);
    agent.close();

    agent = new AgentSide(db);
    assert.equal(agent.confirmedWatermark(), 2);
    const again = agent.receiveEvent("e1", makeBody(1));
    assert.deepEqual(again, { seq: 1, created: false });
    assert.deepEqual(agent.pendingEvents(), []);
    agent.close();
  } finally {
    dir.cleanup();
  }
});

test("supports a backlog of 10000 events of 4KiB each", () => {
  const dir = tempDir();
  try {
    const agent = new AgentSide(dir.file("agent.db"));
    const total = 10000;
    for (let i = 1; i <= total; i++) {
      const r = agent.receiveEvent(`ev-${i}`, makeBody(i, 4096));
      assert.equal(r.seq, i);
    }
    const pending = agent.pendingEvents();
    assert.equal(pending.length, total);
    assert.equal(pending[total - 1].seq, total);
    assert.equal(pending[0].body.length, 4096);
    agent.applyAck(total);
    assert.equal(agent.pendingEvents().length, 0);
    assert.equal(agent.confirmedWatermark(), total);
    agent.close();
  } finally {
    dir.cleanup();
  }
});
