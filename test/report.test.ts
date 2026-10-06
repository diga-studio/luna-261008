import { test } from "node:test";
import assert from "node:assert/strict";
import { PipelineStore, generateReport, WINDOW_MS } from "../src/index.js";
import type { StageChange } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = Date.UTC(2026, 3, 1); // 2026-04-01T00:00:00.000Z
const LEFT = AS_OF - WINDOW_MS; // window left endpoint, 90 days before AS_OF

function stats(totalMs: number, segments: number) {
  return { segments, totalMs, averageMs: segments === 0 ? 0 : totalMs / segments };
}

test("round trip back to an earlier stage counts as separate segments", () => {
  const store = new PipelineStore();
  store.submitHistory("c1", [
    { at: LEFT - 10 * DAY, stage: "Contacted" },
    { at: LEFT + 5 * DAY, stage: "Engaged" },
    { at: LEFT + 20 * DAY, stage: "Contacted" },
  ]);

  const report = generateReport(store, AS_OF);

  // Contacted: [LEFT, LEFT+5d) = 5d plus [LEFT+20d, AS_OF) = 70d, still open.
  assert.deepEqual(report["Contacted"], stats(75 * DAY, 2));
  assert.equal(report["Contacted"].averageMs, 37.5 * DAY);
  assert.deepEqual(report["Engaged"], stats(15 * DAY, 1));
  assert.deepEqual(report["Identified"], stats(0, 0));
  assert.deepEqual(report["Placed"], stats(0, 0));
});

test("segment ending exactly at window left is excluded", () => {
  const store = new PipelineStore();
  store.submitHistory("c1", [
    { at: LEFT - 30 * DAY, stage: "Identified" },
    { at: LEFT, stage: "Engaged" },
  ]);

  const report = generateReport(store, AS_OF);

  assert.deepEqual(report["Identified"], stats(0, 0));
  // Left-closed window: the Engaged segment starting exactly at LEFT counts in full.
  assert.deepEqual(report["Engaged"], stats(90 * DAY, 1));
});

test("segment starting exactly at window right is excluded", () => {
  const store = new PipelineStore();
  store.submitHistory("c1", [
    { at: LEFT - 5 * DAY, stage: "Contacted" },
    { at: AS_OF, stage: "Interviewing" },
  ]);

  const report = generateReport(store, AS_OF);

  assert.deepEqual(report["Contacted"], stats(90 * DAY, 1));
  assert.deepEqual(report["Interviewing"], stats(0, 0));
});

test("candidate with no change inside the window still counts", () => {
  const store = new PipelineStore();
  store.submitHistory("c1", [{ at: LEFT - 1000 * DAY, stage: "Submitted to Client" }]);

  const report = generateReport(store, AS_OF);

  assert.deepEqual(report["Submitted to Client"], stats(90 * DAY, 1));
});

test("candidate whose whole history is after the window contributes nothing", () => {
  const store = new PipelineStore();
  store.submitHistory("c1", [{ at: AS_OF + DAY, stage: "Identified" }]);

  const report = generateReport(store, AS_OF);

  assert.deepEqual(report["Identified"], stats(0, 0));
});

test("replacing history removes old contributions and matches a fresh store", () => {
  const original: StageChange[] = [
    { at: LEFT - 80 * DAY, stage: "Identified" },
    { at: LEFT - 5 * DAY, stage: "Contacted" },
    { at: LEFT + 5 * DAY, stage: "Identified" },
    { at: LEFT + 30 * DAY, stage: "Engaged" },
  ];
  // Correction: the Contacted round trip never happened.
  const corrected: StageChange[] = [
    { at: LEFT - 80 * DAY, stage: "Identified" },
    { at: LEFT + 30 * DAY, stage: "Engaged" },
  ];

  const store = new PipelineStore();
  store.submitHistory("c1", original);
  const before = generateReport(store, AS_OF);
  assert.deepEqual(before["Contacted"], stats(5 * DAY, 1));
  assert.deepEqual(before["Identified"], stats(25 * DAY, 1));

  store.replaceHistory("c1", corrected);
  const after = generateReport(store, AS_OF);

  // Old Contacted contribution must not remain.
  assert.deepEqual(after["Contacted"], stats(0, 0));
  assert.deepEqual(after["Identified"], stats(30 * DAY, 1));
  assert.deepEqual(after["Engaged"], stats(60 * DAY, 1));

  // Must equal a report computed from scratch on the corrected history alone.
  const fresh = new PipelineStore();
  fresh.submitHistory("c1", corrected);
  assert.deepEqual(after, generateReport(fresh, AS_OF));
});

test("incremental submits merge into one timeline", () => {
  const incremental = new PipelineStore();
  incremental.submitHistory("c1", [{ at: LEFT - 80 * DAY, stage: "Identified" }]);
  incremental.submitHistory("c1", [{ at: LEFT + 30 * DAY, stage: "Engaged" }]);

  const oneShot = new PipelineStore();
  oneShot.submitHistory("c1", [
    { at: LEFT - 80 * DAY, stage: "Identified" },
    { at: LEFT + 30 * DAY, stage: "Engaged" },
  ]);

  assert.deepEqual(generateReport(incremental, AS_OF), generateReport(oneShot, AS_OF));
});

test("multiple candidates each contribute their own segments", () => {
  const store = new PipelineStore();
  store.submitHistory("c1", [{ at: LEFT - 10 * DAY, stage: "Placed" }]);
  store.submitHistory("c2", [
    { at: LEFT - 10 * DAY, stage: "Placed" },
    { at: LEFT + 40 * DAY, stage: "Alumni" },
  ]);

  const report = generateReport(store, AS_OF);

  assert.deepEqual(report["Placed"], stats(130 * DAY, 2));
  assert.deepEqual(report["Alumni"], stats(50 * DAY, 1));
});

test("invalid histories are rejected and leave stored state unchanged", () => {
  const store = new PipelineStore();
  const valid: StageChange[] = [{ at: LEFT - 10 * DAY, stage: "Engaged" }];
  store.submitHistory("c1", valid);
  const baseline = generateReport(store, AS_OF);

  assert.throws(
    () => store.submitHistory("c2", [{ at: 1.5, stage: "Engaged" }]),
    /integer/,
  );
  assert.throws(
    () =>
      store.submitHistory("c2", [
        { at: LEFT, stage: "Engaged" },
        { at: LEFT, stage: "Placed" },
      ]),
    /strictly increasing/,
  );
  assert.throws(
    () =>
      store.submitHistory("c2", [
        { at: LEFT, stage: "Engaged" },
        { at: LEFT + DAY, stage: "Engaged" },
      ]),
    /different stages/,
  );
  assert.throws(
    () => store.submitHistory("c2", [{ at: LEFT, stage: "Ghost" as never }]),
    /one of/,
  );
  // A merge that would duplicate an existing timestamp must also fail atomically.
  assert.throws(() => store.submitHistory("c1", valid), /strictly increasing/);

  assert.deepEqual(generateReport(store, AS_OF), baseline);
});

test("invalid replacement is rejected and old history stays in effect", () => {
  const store = new PipelineStore();
  store.submitHistory("c1", [{ at: LEFT - 10 * DAY, stage: "Engaged" }]);
  const baseline = generateReport(store, AS_OF);

  assert.throws(() =>
    store.replaceHistory("c1", [
      { at: LEFT, stage: "Placed" },
      { at: LEFT - DAY, stage: "Alumni" },
    ]),
  );

  assert.deepEqual(generateReport(store, AS_OF), baseline);
});

test("asOf must be an integer millisecond timestamp", () => {
  const store = new PipelineStore();
  assert.throws(() => generateReport(store, 1.5), /integer/);
});
