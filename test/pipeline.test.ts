import { test } from "node:test";
import assert from "node:assert/strict";
import { TalentPipeline } from "../src/index.js";
import type { Stage, StageReport } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = 1_800_000_000_000; // fixed UTC instant, ms
const WINDOW_START = AS_OF - 90 * DAY;

function entry(report: StageReport, stage: Stage) {
  const found = report.entries.find((e) => e.stage === stage);
  assert.ok(found, `missing entry for stage ${stage}`);
  return found;
}

test("overlapping segments, repeated stage re-entry, and window boundaries", () => {
  const pipeline = new TalentPipeline();

  // Candidate A: enters Contacted 10d before the window, moves to Engaged 5d
  // into the window, returns to Contacted 20d into the window and stays.
  pipeline.submitHistory("A", [
    { atMs: WINDOW_START - 10 * DAY, stage: "Contacted" },
    { atMs: WINDOW_START + 5 * DAY, stage: "Engaged" },
    { atMs: WINDOW_START + 20 * DAY, stage: "Contacted" },
  ]);

  // Candidate B: segment ending exactly at the window start must not count;
  // the following Contacted segment spans the whole window.
  pipeline.submitHistory("B", [
    { atMs: WINDOW_START - 200 * DAY, stage: "Identified" },
    { atMs: WINDOW_START, stage: "Contacted" },
  ]);

  // Candidate C: segment starting exactly at asOf (window right edge, open)
  // must not count.
  pipeline.submitHistory("C", [{ atMs: AS_OF, stage: "Interviewing" }]);

  const report = pipeline.report(AS_OF);

  const contacted = entry(report, "Contacted");
  assert.equal(contacted.segmentCount, 3); // A twice + B once
  assert.equal(contacted.totalDurationMs, (5 + 70 + 90) * DAY);
  assert.equal(contacted.averageDurationMs, (165 * DAY) / 3);

  const engaged = entry(report, "Engaged");
  assert.equal(engaged.segmentCount, 1);
  assert.equal(engaged.totalDurationMs, 15 * DAY);
  assert.equal(engaged.averageDurationMs, 15 * DAY);

  const identified = entry(report, "Identified");
  assert.equal(identified.segmentCount, 0);
  assert.equal(identified.totalDurationMs, 0);
  assert.equal(identified.averageDurationMs, 0);

  const interviewing = entry(report, "Interviewing");
  assert.equal(interviewing.segmentCount, 0);
  assert.equal(interviewing.totalDurationMs, 0);

  // Exactly the scenario from the requirements, in isolation.
  const solo = new TalentPipeline();
  solo.submitHistory("A", [
    { atMs: WINDOW_START - 10 * DAY, stage: "Contacted" },
    { atMs: WINDOW_START + 5 * DAY, stage: "Engaged" },
    { atMs: WINDOW_START + 20 * DAY, stage: "Contacted" },
  ]);
  const soloContacted = entry(solo.report(AS_OF), "Contacted");
  assert.equal(soloContacted.segmentCount, 2);
  assert.equal(soloContacted.totalDurationMs, 75 * DAY);
  assert.equal(soloContacted.averageDurationMs, 37.5 * DAY);
});

test("replaceHistory fully supersedes old history, including undone round trips", () => {
  const t0 = WINDOW_START + 1 * DAY;
  const t1 = WINDOW_START + 10 * DAY;
  const t2 = WINDOW_START + 30 * DAY;
  const t3 = WINDOW_START + 40 * DAY;

  const pipeline = new TalentPipeline();
  pipeline.submitHistory("X", [
    { atMs: t0, stage: "Identified" },
    { atMs: t1, stage: "Contacted" },
    { atMs: t2, stage: "Identified" },
    { atMs: t3, stage: "Engaged" },
  ]);

  // Correct the record: the Contacted detour and return never happened.
  const corrected = [
    { atMs: t0, stage: "Identified" },
    { atMs: t3, stage: "Engaged" },
  ] as const;
  pipeline.replaceHistory("X", corrected);

  const actual = pipeline.report(AS_OF);

  const expected = new TalentPipeline();
  expected.submitHistory("X", corrected);
  assert.deepEqual(actual, expected.report(AS_OF));

  // No trace of the revoked Contacted stay may remain.
  assert.equal(entry(actual, "Contacted").segmentCount, 0);
  assert.equal(entry(actual, "Contacted").totalDurationMs, 0);
  // Identified is now a single segment [t0, t3), not two split ones.
  assert.equal(entry(actual, "Identified").segmentCount, 1);
  assert.equal(entry(actual, "Identified").totalDurationMs, t3 - t0);
});

test("history before the window can be rewritten by replaceHistory", () => {
  const pipeline = new TalentPipeline();
  pipeline.submitHistory("Y", [
    { atMs: WINDOW_START - 50 * DAY, stage: "Placed" },
    { atMs: WINDOW_START - 40 * DAY, stage: "Alumni" },
  ]);
  // Correction reaches back before the window: the person was actually
  // still Placed throughout.
  pipeline.replaceHistory("Y", [{ atMs: WINDOW_START - 50 * DAY, stage: "Placed" }]);

  const report = pipeline.report(AS_OF);
  assert.equal(entry(report, "Placed").segmentCount, 1);
  assert.equal(entry(report, "Placed").totalDurationMs, 90 * DAY);
  assert.equal(entry(report, "Alumni").segmentCount, 0);
});

test("input validation", () => {
  const pipeline = new TalentPipeline();
  assert.throws(() =>
    pipeline.submitHistory("Z", [
      { atMs: 2000, stage: "Identified" },
      { atMs: 1000, stage: "Contacted" },
    ]),
  );
  assert.throws(() =>
    pipeline.submitHistory("Z", [
      { atMs: 1000, stage: "Identified" },
      { atMs: 2000, stage: "Identified" },
    ]),
  );
  pipeline.submitHistory("Z", [{ atMs: 1000, stage: "Identified" }]);
  assert.throws(() => pipeline.submitHistory("Z", [{ atMs: 3000, stage: "Contacted" }]));
});
