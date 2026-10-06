import test from "node:test";
import assert from "node:assert/strict";
import { SummarySide } from "../src/summary";
import { makeBody, tempDir } from "./helpers";

test("out-of-order arrivals are held until the gap is filled", () => {
  const dir = tempDir();
  try {
    const summary = new SummarySide(dir.file("summary.db"));
    let wm = summary.ingest("agent-a", [
      { seq: 3, eventId: "e3", body: makeBody(3) },
      { seq: 4, eventId: "e4", body: makeBody(4) },
    ]);
    assert.equal(wm, 0);
    assert.deepEqual(summary.records("agent-a"), []);

    wm = summary.ingest("agent-a", [
      { seq: 1, eventId: "e1", body: makeBody(1) },
      { seq: 2, eventId: "e2", body: makeBody(2) },
    ]);
    assert.equal(wm, 4);
    const records = summary.records("agent-a");
    assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4]);
    assert.deepEqual([...records[2].body], [...makeBody(3)]);
    summary.close();
  } finally {
    dir.cleanup();
  }
});

test("duplicate delivery does not add records and watermark survives restart", () => {
  const dir = tempDir();
  const db = dir.file("summary.db");
  try {
    let summary = new SummarySide(db);
    const batch = [
      { seq: 1, eventId: "e1", body: makeBody(1) },
      { seq: 2, eventId: "e2", body: makeBody(2) },
    ];
    assert.equal(summary.ingest("agent-a", batch), 2);
    // Retransmission of the same batch (receipt lost on the way back).
    assert.equal(summary.ingest("agent-a", batch), 2);
    assert.equal(summary.records("agent-a").length, 2);
    summary.close();

    summary = new SummarySide(db);
    assert.equal(summary.watermark("agent-a"), 2);
    assert.equal(summary.records("agent-a").length, 2);
    assert.equal(summary.ingest("agent-a", batch), 2);
    assert.equal(summary.records("agent-a").length, 2);
    summary.close();
  } finally {
    dir.cleanup();
  }
});

test("watermarks are independent per agent", () => {
  const dir = tempDir();
  try {
    const summary = new SummarySide(dir.file("summary.db"));
    summary.ingest("agent-a", [{ seq: 1, eventId: "a1", body: makeBody(1) }]);
    summary.ingest("agent-b", [{ seq: 5, eventId: "b5", body: makeBody(5) }]);
    assert.equal(summary.watermark("agent-a"), 1);
    assert.equal(summary.watermark("agent-b"), 0);
    assert.equal(summary.records("agent-b").length, 0);
    summary.close();
  } finally {
    dir.cleanup();
  }
});
