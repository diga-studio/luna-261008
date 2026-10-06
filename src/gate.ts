import type { DatabaseSync } from 'node:sqlite';
import type { ComponentGateView, ExpectedState, GateBasis } from './types.js';

export const PASS_THRESHOLD = 0.95;

export interface ReleaseFacts {
  components: ComponentGateView[];
  checklist: { item: string; done: boolean }[];
}

interface TestRow {
  test_id: string;
  completed_at: number;
  passed: number;
  total: number;
  skipped: number;
}

/** 从当前数据库事实重算某发布的门禁事实（实际状态、最新测试、P0 阻塞集合、清单）。 */
export function computeReleaseFacts(db: DatabaseSync, releaseId: string): ReleaseFacts {
  const componentRows = db
    .prepare('SELECT component_id FROM release_components WHERE release_id = ? ORDER BY component_id')
    .all(releaseId) as { component_id: string }[];

  const expectedStmt = db.prepare(
    'SELECT state FROM expected_states WHERE release_id = ? AND component_id = ?',
  );
  const p0Stmt = db.prepare(
    "SELECT bug_id FROM bugs WHERE component_id = ? AND severity = 'P0' AND status IN ('Open', 'In Progress') ORDER BY bug_id",
  );
  const testStmt = db.prepare(
    'SELECT test_id, completed_at, passed, total, skipped FROM tests WHERE release_id = ? AND component_id = ?',
  );

  const components: ComponentGateView[] = componentRows.map(({ component_id }) => {
    const expectedRow = expectedStmt.get(releaseId, component_id) as { state: string } | undefined;
    const expected = (expectedRow?.state ?? 'Not Started') as ExpectedState;

    const p0BlockingBugs = (p0Stmt.all(component_id) as { bug_id: string }[]).map((r) => r.bug_id);

    const tests = testStmt.all(releaseId, component_id) as unknown as TestRow[];
    let latest: TestRow | null = null;
    for (const row of tests) {
      if (
        latest === null ||
        row.completed_at > latest.completed_at ||
        (row.completed_at === latest.completed_at && row.test_id > latest.test_id)
      ) {
        latest = row;
      }
    }

    const latestTest = latest
      ? {
          testId: latest.test_id,
          completedAt: latest.completed_at,
          passed: latest.passed,
          total: latest.total,
          skipped: latest.skipped,
          passRate: latest.total > 0 ? latest.passed / latest.total : 0,
          passing: latest.total > 0 && latest.passed / latest.total >= PASS_THRESHOLD,
        }
      : null;

    let actual: ExpectedState;
    if (p0BlockingBugs.length > 0) {
      actual = 'Blocked';
    } else if (expected === 'Ready' && !(latestTest?.passing ?? false)) {
      actual = 'In Progress';
    } else {
      actual = expected;
    }

    return { componentId: component_id, expected, actual, p0BlockingBugs, latestTest };
  });

  const checklist = (
    db
      .prepare('SELECT item, done FROM release_checklist WHERE release_id = ? ORDER BY item')
      .all(releaseId) as { item: string; done: number }[]
  ).map((r) => ({ item: r.item, done: r.done !== 0 }));

  return { components, checklist };
}

/** 基于事实判断可发布性与阻塞原因。 */
export function evaluateGate(facts: ReleaseFacts): { releasable: boolean; blockingReasons: string[] } {
  const blockingReasons: string[] = [];

  for (const component of facts.components) {
    if (component.p0BlockingBugs.length > 0) {
      blockingReasons.push(
        `component ${component.componentId}: blocked by P0 bugs [${component.p0BlockingBugs.join(', ')}]`,
      );
    } else if (component.expected === 'Ready' && !(component.latestTest?.passing ?? false)) {
      const detail = component.latestTest
        ? `latest test ${component.latestTest.testId} pass rate ${(component.latestTest.passRate * 100).toFixed(2)}% < 95%`
        : 'no tests';
      blockingReasons.push(`component ${component.componentId}: expected Ready but ${detail}`);
    } else if (component.actual !== 'Ready') {
      blockingReasons.push(
        `component ${component.componentId}: actual state is ${component.actual} (expected ${component.expected})`,
      );
    }
  }

  for (const item of facts.checklist) {
    if (!item.done) {
      blockingReasons.push(`checklist item not done: ${item.item}`);
    }
  }

  return { releasable: blockingReasons.length === 0, blockingReasons };
}

/** 影响确认凭据有效性的事实指纹：期望状态、最新测试、P0 阻塞集合、清单完成标记。 */
export function relevantFingerprint(facts: ReleaseFacts): string {
  return JSON.stringify({
    expected: facts.components.map((c) => [c.componentId, c.expected]),
    latestTests: facts.components.map((c) => [
      c.componentId,
      c.latestTest ? [c.latestTest.testId, c.latestTest.completedAt] : null,
    ]),
    p0: facts.components.map((c) => [c.componentId, c.p0BlockingBugs]),
    checklist: facts.checklist.map((i) => [i.item, i.done]),
  });
}

export function toBasis(releaseId: string, facts: ReleaseFacts): GateBasis {
  return {
    releaseId,
    components: facts.components.map((c) => ({
      componentId: c.componentId,
      expected: c.expected,
      actual: c.actual,
      p0BlockingBugs: [...c.p0BlockingBugs],
      latestTest: c.latestTest ? { ...c.latestTest } : null,
    })),
    checklist: facts.checklist.map((i) => ({ ...i })),
  };
}
