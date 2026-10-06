import { DatabaseSync } from "node:sqlite";
import {
  ActualState,
  ChecklistItemBasis,
  ComponentGateBasis,
  ExpectedState,
  GateBasis,
  GateBlocker,
  TestBasis,
} from "./types";

export const PASS_THRESHOLD = 0.95;

interface TestRow {
  test_id: string;
  passed: number;
  total: number;
  skipped: number;
  completed_at: number;
}

function toTestBasis(row: TestRow): TestBasis {
  const passRate = row.total > 0 ? row.passed / row.total : 0;
  return {
    testId: row.test_id,
    passed: row.passed,
    total: row.total,
    skipped: row.skipped,
    completedAt: row.completed_at,
    passRate,
    meetsThreshold: row.total > 0 && passRate >= PASS_THRESHOLD,
  };
}

function deriveActual(
  expected: ExpectedState,
  blockingP0: boolean,
  latestTest: TestBasis | null,
): ActualState {
  if (blockingP0) return "Blocked";
  if (expected === "Ready" && !(latestTest !== null && latestTest.meetsThreshold)) {
    return "In Progress";
  }
  return expected;
}

/** 从当前事实重算发布的门禁依据。 */
export function computeBasis(db: DatabaseSync, releaseId: string): GateBasis {
  const componentRows = db
    .prepare(
      "SELECT component_id FROM release_components WHERE release_id = ? ORDER BY component_id",
    )
    .all(releaseId) as unknown as { component_id: string }[];

  const expectedStmt = db.prepare(
    "SELECT expected FROM expectations WHERE release_id = ? AND component_id = ?",
  );
  const blockingStmt = db.prepare(
    "SELECT bug_id FROM bugs WHERE component_id = ? AND severity = 'P0' AND status IN ('Open', 'In Progress') ORDER BY bug_id",
  );
  const latestTestStmt = db.prepare(
    "SELECT test_id, passed, total, skipped, completed_at FROM tests " +
      "WHERE release_id = ? AND component_id = ? " +
      "ORDER BY completed_at DESC, test_id DESC LIMIT 1",
  );

  const components: ComponentGateBasis[] = componentRows.map((row) => {
    const componentId = row.component_id;
    const expectedRow = expectedStmt.get(releaseId, componentId) as
      | { expected: string }
      | undefined;
    const expected = (expectedRow?.expected ?? "Not Started") as ExpectedState;
    const blockingP0BugIds = (
      blockingStmt.all(componentId) as unknown as { bug_id: string }[]
    ).map((b) => b.bug_id);
    const testRow = latestTestStmt.get(releaseId, componentId) as TestRow | undefined;
    const latestTest = testRow ? toTestBasis(testRow) : null;
    const actual = deriveActual(expected, blockingP0BugIds.length > 0, latestTest);
    return { componentId, expected, actual, blockingP0BugIds, latestTest };
  });

  const checklist: ChecklistItemBasis[] = (
    db
      .prepare(
        "SELECT item_id, label, done FROM release_checklist WHERE release_id = ? ORDER BY item_id",
      )
      .all(releaseId) as unknown as { item_id: string; label: string | null; done: number }[]
  ).map((row) => ({ itemId: row.item_id, label: row.label, done: row.done !== 0 }));

  return { components, checklist };
}

/** 由依据推导阻塞项；为空表示可发布。 */
export function evaluateBlockers(basis: GateBasis): GateBlocker[] {
  const blockers: GateBlocker[] = [];
  for (const component of basis.components) {
    if (component.blockingP0BugIds.length > 0) {
      blockers.push({
        reason: "P0_BUG_BLOCKING",
        componentId: component.componentId,
        detail: `P0 bug(s) open: ${component.blockingP0BugIds.join(", ")}`,
      });
    }
    if (
      component.expected === "Ready" &&
      component.blockingP0BugIds.length === 0 &&
      !(component.latestTest !== null && component.latestTest.meetsThreshold)
    ) {
      blockers.push({
        reason: "TEST_NOT_QUALIFIED",
        componentId: component.componentId,
        detail:
          component.latestTest === null
            ? "no test recorded"
            : `latest test ${component.latestTest.testId} pass rate ${component.latestTest.passRate} below ${PASS_THRESHOLD}`,
      });
    }
    if (component.actual !== "Ready") {
      blockers.push({
        reason: "COMPONENT_NOT_READY",
        componentId: component.componentId,
        detail: `actual state is ${component.actual} (expected ${component.expected})`,
      });
    }
  }
  for (const item of basis.checklist) {
    if (!item.done) {
      blockers.push({
        reason: "CHECKLIST_INCOMPLETE",
        itemId: item.itemId,
        detail: `checklist item ${item.itemId} not done`,
      });
    }
  }
  return blockers;
}
