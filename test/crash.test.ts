import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { AgentSide } from "../src/agent";
import { SummarySide } from "../src/summary";
import { makeBody, tempDir } from "./helpers";

const CHILD = join(__dirname, "crash_child.js");

/** Spawn the crash child, kill it after `killAfterLines` stdout lines. */
function crashRun(args: string[], killAfterLines: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let lines = 0;
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      lines += chunk.toString().split("\n").length - 1;
      if (!killed && lines >= killAfterLines) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

test("crash during receive: same-id retry yields no dup and no seq gap", async () => {
  const dir = tempDir();
  const db = dir.file("agent.db");
  try {
    await crashRun(["receive", db, "500"], 137);

    const agent = new AgentSide(db);
    for (let i = 1; i <= 500; i++) {
      const r = agent.receiveEvent(`ev-${i}`, makeBody(i));
      assert.equal(r.seq, i, `event ev-${i} must map to seq ${i}`);
    }
    const pending = agent.pendingEvents();
    assert.equal(pending.length, 500);
    assert.deepEqual(
      pending.map((p) => p.seq),
      Array.from({ length: 500 }, (_, i) => i + 1),
    );
    for (const p of pending) {
      assert.deepEqual([...p.body], [...makeBody(p.seq)]);
    }
    agent.close();
  } finally {
    dir.cleanup();
  }
});

test("crash during ack cleanup: re-ack completes, mapping and seqs intact", async () => {
  const dir = tempDir();
  const db = dir.file("agent.db");
  try {
    const total = 20000;
    const setup = new AgentSide(db);
    for (let i = 1; i <= total; i++) setup.receiveEvent(`ev-${i}`, makeBody(i));
    setup.close();

    // Kill the acking process at an arbitrary moment mid-cleanup.
    await crashRun(["ack", db, String(total)], 0);

    const agent = new AgentSide(db);
    // Late/stale ack retry must finish the job without regression.
    agent.applyAck(total);
    assert.equal(agent.confirmedWatermark(), total);
    assert.equal(agent.pendingEvents().length, 0);

    // Cleaned event ids still resolve to their original seqs.
    const again = agent.receiveEvent("ev-1", makeBody(1));
    assert.deepEqual(again, { seq: 1, created: false });
    // New events continue the sequence without a gap.
    const next = agent.receiveEvent(`ev-${total + 1}`, makeBody(total + 1));
    assert.equal(next.seq, total + 1);
    assert.deepEqual(agent.pendingEvents().map((p) => p.seq), [total + 1]);
    agent.close();
  } finally {
    dir.cleanup();
  }
});

test("crash during summary ingest plus lost receipt: retransmit converges", async () => {
  const dir = tempDir();
  const agentDb = dir.file("agent.db");
  const summaryDb = dir.file("summary.db");
  try {
    const total = 300;
    const agent = new AgentSide(agentDb);
    for (let i = 1; i <= total; i++) agent.receiveEvent(`ev-${i}`, makeBody(i));

    // Summary process crashes mid-ingest; its receipt never reaches the agent.
    await crashRun(["ingest", summaryDb, String(total)], 120);

    // Summary restarts; watermark must not have regressed after reopen.
    let summary = new SummarySide(summaryDb);
    const wmBefore = summary.watermark("agent-x");
    summary.close();
    summary = new SummarySide(summaryDb);
    assert.equal(summary.watermark("agent-x"), wmBefore);

    // Agent restarts too, then keeps retransmitting its backlog.
    agent.close();
    const agent2 = new AgentSide(agentDb);
    const wm = summary.ingest("agent-x", agent2.pendingEvents());
    assert.equal(wm, total);

    // Receipt lost again: full retransmission must not duplicate records.
    const wm2 = summary.ingest("agent-x", agent2.pendingEvents());
    assert.equal(wm2, total);
    const records = summary.records("agent-x");
    assert.equal(records.length, total);
    for (const rec of records) {
      assert.deepEqual([...rec.body], [...makeBody(rec.seq)]);
    }

    // Receipt finally arrives; agent cleans up and stays consistent.
    agent2.applyAck(wm2);
    assert.equal(agent2.pendingEvents().length, 0);
    agent2.close();
    summary.close();
  } finally {
    dir.cleanup();
  }
});
