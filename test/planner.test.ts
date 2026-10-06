import assert from "node:assert/strict";
import test from "node:test";
import { Adjustment, HistoryRecord, OrgPlanner } from "../src";

const POSITIONS = ["CEO", "VP", "DIR", "IC"];

/** DIR -> VP -> CEO -> (none), IC -> (none), for all time. */
function baseHistory(): HistoryRecord[] {
  return [
    { positionId: "CEO", managerId: null, start: null, end: null },
    { positionId: "VP", managerId: "CEO", start: null, end: null },
    { positionId: "DIR", managerId: "VP", start: null, end: null },
    { positionId: "IC", managerId: "DIR", start: null, end: null },
  ];
}

function newPlanner(): OrgPlanner {
  const planner = new OrgPlanner(POSITIONS);
  planner.loadHistory(baseHistory());
  return planner;
}

test("snapshot reconstructs the organization for a given day", () => {
  const planner = newPlanner();
  assert.deepEqual(planner.getSnapshot("06/15/2024"), {
    CEO: null,
    VP: "CEO",
    DIR: "VP",
    IC: "DIR",
  });
});

test("adjustment applies inside [start, end) only and preserves history outside", () => {
  const planner = newPlanner();
  const result = planner.applyBatch([
    { positionId: "IC", newManagerId: "VP", start: "01/10/2025", end: "01/20/2025" },
  ]);
  assert.equal(result.accepted, true);
  assert.equal(planner.getManager("IC", "01/09/2025"), "DIR");
  assert.equal(planner.getManager("IC", "01/10/2025"), "VP");
  assert.equal(planner.getManager("IC", "01/19/2025"), "VP");
  assert.equal(planner.getManager("IC", "01/20/2025"), "DIR");
  assert.equal(planner.getManager("IC", "12/31/1999"), "DIR");
  assert.equal(planner.getManager("IC", "12/31/2099"), "DIR");
});

test("null end means the adjustment extends into the infinite future", () => {
  const planner = newPlanner();
  const result = planner.applyBatch([
    { positionId: "IC", newManagerId: null, start: "03/01/2025", end: null },
  ]);
  assert.equal(result.accepted, true);
  assert.equal(planner.getManager("IC", "02/28/2025"), "DIR");
  assert.equal(planner.getManager("IC", "03/01/2025"), null);
  assert.equal(planner.getManager("IC", "01/01/2100"), null);
});

test("later adjustments override overlapping history without erasing surrounding days", () => {
  const planner = newPlanner();
  planner.applyBatch([
    { positionId: "IC", newManagerId: "VP", start: "01/01/2025", end: "03/01/2025" },
  ]);
  planner.applyBatch([
    { positionId: "IC", newManagerId: "CEO", start: "02/01/2025", end: "02/10/2025" },
  ]);
  assert.equal(planner.getManager("IC", "01/15/2025"), "VP");
  assert.equal(planner.getManager("IC", "02/05/2025"), "CEO");
  assert.equal(planner.getManager("IC", "02/15/2025"), "VP");
  assert.equal(planner.getManager("IC", "03/15/2025"), "DIR");
});

test("swapping two levels in one batch is accepted when the final org is acyclic", () => {
  const planner = newPlanner();
  // Make CEO report to VP and VP top-level: each adjustment alone would
  // close a cycle with the stored history, together they do not.
  const result = planner.applyBatch([
    { positionId: "CEO", newManagerId: "VP", start: "01/01/2025", end: "02/01/2025" },
    { positionId: "VP", newManagerId: null, start: "01/01/2025", end: "02/01/2025" },
  ]);
  assert.equal(result.accepted, true);
  assert.deepEqual(planner.getSnapshot("01/15/2025"), {
    CEO: "VP",
    VP: null,
    DIR: "VP",
    IC: "DIR",
  });
  assert.deepEqual(planner.getSnapshot("12/15/2024"), {
    CEO: null,
    VP: "CEO",
    DIR: "VP",
    IC: "DIR",
  });
});

test("a cycle existing only a few days inside the interval rejects the whole batch", () => {
  const planner = newPlanner();
  // CEO -> VP would close CEO -> VP -> CEO only between 01/10 and 01/12.
  const result = planner.applyBatch([
    { positionId: "VP", newManagerId: null, start: "01/01/2025", end: "01/10/2025" },
    { positionId: "VP", newManagerId: null, start: "01/12/2025", end: "02/01/2025" },
    { positionId: "CEO", newManagerId: "VP", start: "01/01/2025", end: "02/01/2025" },
  ]);
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /cycle/);
  // Original history is completely untouched, past and future.
  assert.deepEqual(planner.getSnapshot("01/11/2025"), {
    CEO: null,
    VP: "CEO",
    DIR: "VP",
    IC: "DIR",
  });
  assert.deepEqual(planner.getSnapshot("06/01/1999"), planner.getSnapshot("06/01/2099"));
  assert.equal(planner.getManager("VP", "01/05/2025"), "CEO");
});

test("A->B in January and B->A in February is legal (never simultaneous)", () => {
  const planner = new OrgPlanner(["A", "B"]);
  planner.loadHistory([
    { positionId: "A", managerId: null, start: null, end: null },
    { positionId: "B", managerId: null, start: null, end: null },
  ]);
  const result = planner.applyBatch([
    { positionId: "A", newManagerId: "B", start: "01/01/2025", end: "02/01/2025" },
    { positionId: "B", newManagerId: "A", start: "02/01/2025", end: "03/01/2025" },
  ]);
  assert.equal(result.accepted, true);
  assert.equal(planner.getManager("A", "01/15/2025"), "B");
  assert.equal(planner.getManager("B", "02/15/2025"), "A");
});

test("a batch that would cycle in the far future is rejected", () => {
  const planner = newPlanner();
  const result = planner.applyBatch([
    { positionId: "CEO", newManagerId: "IC", start: "01/01/2030", end: null },
  ]);
  assert.equal(result.accepted, false);
  assert.equal(planner.getManager("CEO", "01/01/2030"), null);
});

test("overlapping adjustments for the same position in one batch are rejected", () => {
  const planner = newPlanner();
  const result = planner.applyBatch([
    { positionId: "IC", newManagerId: "VP", start: "01/01/2025", end: "02/01/2025" },
    { positionId: "IC", newManagerId: "CEO", start: "01/15/2025", end: "03/01/2025" },
  ]);
  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /overlapping/);
  assert.equal(planner.getManager("IC", "01/20/2025"), "DIR");
});

test("malformed adjustments reject the batch without touching history", () => {
  const cases: Adjustment[] = [
    { positionId: "NOPE", newManagerId: "VP", start: "01/01/2025", end: "02/01/2025" },
    { positionId: "IC", newManagerId: "NOPE", start: "01/01/2025", end: "02/01/2025" },
    { positionId: "IC", newManagerId: "IC", start: "01/01/2025", end: "02/01/2025" },
    { positionId: "IC", newManagerId: "VP", start: "02/01/2025", end: "01/01/2025" },
    { positionId: "IC", newManagerId: "VP", start: "13/01/2025", end: "02/01/2025" },
    { positionId: "IC", newManagerId: "VP", start: "02/30/2025", end: "03/01/2025" },
    { positionId: "IC", newManagerId: "VP", start: "2025-01-01", end: "02/01/2025" },
  ];
  for (const adjustment of cases) {
    const planner = newPlanner();
    const result = planner.applyBatch([adjustment]);
    assert.equal(result.accepted, false, JSON.stringify(adjustment));
    assert.equal(planner.getManager("IC", "01/15/2025"), "DIR");
  }
});

test("initial history must cover every day exactly once", () => {
  const gap = new OrgPlanner(["A", "B"]);
  assert.throws(() =>
    gap.loadHistory([
      { positionId: "A", managerId: null, start: null, end: "01/01/2025" },
      { positionId: "B", managerId: null, start: null, end: null },
    ])
  );
  const overlap = new OrgPlanner(["A", "B"]);
  assert.throws(() =>
    overlap.loadHistory([
      { positionId: "A", managerId: null, start: null, end: null },
      { positionId: "A", managerId: "B", start: "01/01/2025", end: null },
      { positionId: "B", managerId: null, start: null, end: null },
    ])
  );
});

test("initial history with a cycle is rejected", () => {
  const planner = new OrgPlanner(["A", "B"]);
  assert.throws(
    () =>
      planner.loadHistory([
        { positionId: "A", managerId: "B", start: null, end: null },
        { positionId: "B", managerId: "A", start: null, end: null },
      ]),
    /cycle/
  );
});

test("initial history can only be loaded once", () => {
  const planner = newPlanner();
  assert.throws(() => planner.loadHistory(baseHistory()));
});

test("dates are compared by calendar day, independent of host timezone", () => {
  const planner = newPlanner();
  planner.applyBatch([
    { positionId: "IC", newManagerId: "VP", start: "01/01/2025", end: "01/02/2025" },
  ]);
  // A single-day adjustment must affect exactly one calendar day.
  assert.equal(planner.getManager("IC", "12/31/2024"), "DIR");
  assert.equal(planner.getManager("IC", "01/01/2025"), "VP");
  assert.equal(planner.getManager("IC", "01/02/2025"), "DIR");
});
