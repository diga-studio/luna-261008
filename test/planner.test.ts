import { test } from "node:test";
import assert from "node:assert/strict";
import { OrgPlanner } from "../src/index.js";
import type { HistoryRecord } from "../src/index.js";

const POSITIONS = ["ceo", "eng", "sales"] as const;

function record(
  positionId: string,
  managerId: string | null,
  startDate = "01/01/2020",
  endDate: string | null = null,
): HistoryRecord {
  return { positionId, managerId, startDate, endDate };
}

/** Org where eng reports to ceo for all time, sales has no manager. */
function makePlanner(): OrgPlanner {
  const planner = new OrgPlanner(POSITIONS);
  planner.loadInitialHistory([
    record("ceo", null),
    record("eng", "ceo"),
    record("sales", null),
  ]);
  return planner;
}

test("batch swapping two levels is accepted when the final org is acyclic", () => {
  const planner = makePlanner();
  // eng reports to ceo. Swap them: ceo reports to eng, eng becomes top.
  // Either adjustment alone would form a 2-cycle; together they are legal.
  const result = planner.applyBatch([
    { positionId: "ceo", managerId: "eng", startDate: "03/01/2025", endDate: null },
    { positionId: "eng", managerId: null, startDate: "03/01/2025", endDate: null },
  ]);
  assert.deepEqual(result, { ok: true });
  // History before the swap is untouched.
  assert.equal(planner.getManagerAt("eng", "02/28/2025"), "ceo");
  assert.equal(planner.getManagerAt("ceo", "02/28/2025"), null);
  // After the swap the hierarchy is inverted.
  assert.equal(planner.getManagerAt("ceo", "03/01/2025"), "eng");
  assert.equal(planner.getManagerAt("eng", "03/01/2025"), null);
  assert.deepEqual(planner.getOrgSnapshot("03/15/2025"), {
    ceo: "eng",
    eng: null,
    sales: null,
  });
});

test("batch forming a cycle only on a few days inside its range is rejected, history untouched", () => {
  const planner = new OrgPlanner(POSITIONS);
  planner.loadInitialHistory([
    record("ceo", null),
    // eng has no manager until 01/15/2025, then reports to ceo forever.
    record("eng", null, "01/01/2020", "01/15/2025"),
    record("eng", "ceo", "01/15/2025", null),
    record("sales", null),
  ]);
  // ceo -> eng over [01/01, 02/01). The 2-cycle ceo<->eng only exists
  // during 01/15..02/01, a few days inside the adjustment range.
  const result = planner.applyBatch([
    { positionId: "ceo", managerId: "eng", startDate: "01/01/2025", endDate: "02/01/2025" },
  ]);
  assert.equal(result.ok, false);
  // Past, in-range and future history all remain exactly as before.
  assert.equal(planner.getManagerAt("ceo", "01/10/2025"), null);
  assert.equal(planner.getManagerAt("ceo", "01/20/2025"), null);
  assert.equal(planner.getManagerAt("ceo", "03/01/2025"), null);
  assert.equal(planner.getManagerAt("eng", "01/10/2025"), null);
  assert.equal(planner.getManagerAt("eng", "01/20/2025"), "ceo");
  assert.equal(planner.getManagerAt("eng", "06/01/2026"), "ceo");
});

test("adjustment replaces only its range and preserves history outside", () => {
  const planner = makePlanner();
  const result = planner.applyBatch([
    { positionId: "eng", managerId: "sales", startDate: "03/01/2025", endDate: "04/01/2025" },
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(planner.getManagerAt("eng", "02/28/2025"), "ceo");
  assert.equal(planner.getManagerAt("eng", "03/01/2025"), "sales");
  assert.equal(planner.getManagerAt("eng", "03/31/2025"), "sales");
  assert.equal(planner.getManagerAt("eng", "04/01/2025"), "ceo");
});

test("later batch overrides overlapping history but keeps the edges", () => {
  const planner = makePlanner();
  assert.ok(
    planner.applyBatch([
      { positionId: "eng", managerId: "sales", startDate: "03/01/2025", endDate: "06/01/2025" },
    ]).ok,
  );
  assert.ok(
    planner.applyBatch([
      { positionId: "eng", managerId: null, startDate: "04/01/2025", endDate: "05/01/2025" },
    ]).ok,
  );
  assert.equal(planner.getManagerAt("eng", "02/15/2025"), "ceo");
  assert.equal(planner.getManagerAt("eng", "03/15/2025"), "sales");
  assert.equal(planner.getManagerAt("eng", "04/15/2025"), null);
  assert.equal(planner.getManagerAt("eng", "05/15/2025"), "sales");
  assert.equal(planner.getManagerAt("eng", "06/15/2025"), "ceo");
});

test("batch with overlapping ranges for the same position is rejected", () => {
  const planner = makePlanner();
  const result = planner.applyBatch([
    { positionId: "eng", managerId: "sales", startDate: "03/01/2025", endDate: "05/01/2025" },
    { positionId: "eng", managerId: null, startDate: "04/01/2025", endDate: "06/01/2025" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(planner.getManagerAt("eng", "04/15/2025"), "ceo");
});

test("adjustments referencing unknown positions or self-management are rejected", () => {
  const planner = makePlanner();
  assert.equal(
    planner.applyBatch([
      { positionId: "ghost", managerId: "ceo", startDate: "03/01/2025", endDate: null },
    ]).ok,
    false,
  );
  assert.equal(
    planner.applyBatch([
      { positionId: "eng", managerId: "ghost", startDate: "03/01/2025", endDate: null },
    ]).ok,
    false,
  );
  assert.equal(
    planner.applyBatch([
      { positionId: "eng", managerId: "eng", startDate: "03/01/2025", endDate: null },
    ]).ok,
    false,
  );
  assert.equal(planner.getManagerAt("eng", "03/01/2025"), "ceo");
});

test("empty or inverted adjustment ranges are rejected", () => {
  const planner = makePlanner();
  assert.equal(
    planner.applyBatch([
      { positionId: "eng", managerId: "sales", startDate: "05/01/2025", endDate: "05/01/2025" },
    ]).ok,
    false,
  );
  assert.equal(
    planner.applyBatch([
      { positionId: "eng", managerId: "sales", startDate: "06/01/2025", endDate: "05/01/2025" },
    ]).ok,
    false,
  );
});

test("same two reporting directions at different times are legal", () => {
  const planner = makePlanner();
  // ceo reports to eng in March, eng reports to ceo in May: never a cycle.
  const result = planner.applyBatch([
    { positionId: "ceo", managerId: "eng", startDate: "03/01/2025", endDate: "04/01/2025" },
    { positionId: "eng", managerId: null, startDate: "03/01/2025", endDate: "04/01/2025" },
  ]);
  assert.deepEqual(result, { ok: true });
  assert.equal(planner.getManagerAt("ceo", "03/15/2025"), "eng");
  assert.equal(planner.getManagerAt("eng", "05/15/2025"), "ceo");
});

test("initial history with a cycle is rejected at load time", () => {
  const planner = new OrgPlanner(POSITIONS);
  assert.throws(() =>
    planner.loadInitialHistory([
      record("ceo", "eng"),
      record("eng", "ceo"),
      record("sales", null),
    ]),
  );
});

test("initial history must cover all dates for every position", () => {
  const planner = new OrgPlanner(POSITIONS);
  assert.throws(() =>
    planner.loadInitialHistory([
      record("ceo", null),
      record("eng", "ceo", "01/01/2020", "01/01/2025"),
      record("sales", null),
    ]),
  );
  const planner2 = new OrgPlanner(POSITIONS);
  assert.throws(() =>
    planner2.loadInitialHistory([record("ceo", null), record("eng", "ceo")]),
  );
});

test("queries before loading initial history throw", () => {
  const planner = new OrgPlanner(POSITIONS);
  assert.throws(() => planner.getManagerAt("eng", "01/01/2025"));
});
