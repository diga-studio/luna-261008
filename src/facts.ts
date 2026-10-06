import { DatabaseSync } from "node:sqlite";
import { computeBasis } from "./gate";
import { FactBatch, GateBasis, InitReleaseInput } from "./types";

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * 相关事实指纹：期望状态、最新测试标识、P0 阻塞集合、清单完成标记。
 * 只有指纹变化才使已发放的确认凭据失效。
 */
export function fingerprintOf(basis: GateBasis): string {
  const expectations: Record<string, string> = {};
  const latestTests: Record<string, string | null> = {};
  const blocking: string[] = [];
  for (const component of basis.components) {
    expectations[component.componentId] = component.expected;
    latestTests[component.componentId] = component.latestTest
      ? component.latestTest.testId
      : null;
    blocking.push(...component.blockingP0BugIds);
  }
  const checklist: Record<string, boolean> = {};
  for (const item of basis.checklist) {
    checklist[item.itemId] = item.done;
  }
  blocking.sort();
  return JSON.stringify({
    expectations,
    latestTests,
    blocking: [...new Set(blocking)],
    checklist,
  });
}

function refreshFingerprint(db: DatabaseSync, releaseId: string): void {
  const fingerprint = fingerprintOf(computeBasis(db, releaseId));
  db.prepare("UPDATE releases SET fingerprint = ? WHERE release_id = ?").run(
    fingerprint,
    releaseId,
  );
}

/** 事实变化时递增版本，使此前发放的凭据失效（即使之后改回原值）。 */
function bumpVersionIfChanged(
  db: DatabaseSync,
  releaseId: string,
  beforeFingerprint: string,
): void {
  const after = fingerprintOf(computeBasis(db, releaseId));
  if (after !== beforeFingerprint) {
    db.prepare(
      "UPDATE releases SET fact_version = fact_version + 1, fingerprint = ? WHERE release_id = ?",
    ).run(after, releaseId);
  }
}

/** 初始化发布：校验输入并写入发布、组件关联、清单项与默认期望状态。 */
export function initRelease(db: DatabaseSync, input: InitReleaseInput): void {
  if (!input.releaseId) throw new Error("releaseId is required");
  if (!Array.isArray(input.componentIds) || input.componentIds.length === 0) {
    throw new Error("at least one component is required");
  }
  if (!Array.isArray(input.checklistItems) || input.checklistItems.length === 0) {
    throw new Error("at least one checklist item is required");
  }
  const componentIds = [...new Set(input.componentIds)];
  const seenItems = new Set<string>();
  for (const item of input.checklistItems) {
    if (!item.itemId) throw new Error("checklist itemId is required");
    if (seenItems.has(item.itemId)) {
      throw new Error(`duplicate checklist item: ${item.itemId}`);
    }
    seenItems.add(item.itemId);
  }

  inTransaction(db, () => {
    const existing = db
      .prepare("SELECT release_id FROM releases WHERE release_id = ?")
      .get(input.releaseId);
    if (existing) throw new Error(`release already exists: ${input.releaseId}`);

    db.prepare(
      "INSERT INTO releases (release_id, name, status, fact_version, fingerprint, created_at) VALUES (?, ?, 'Planning', 0, '', ?)",
    ).run(input.releaseId, input.name ?? null, Date.now());

    const componentStmt = db.prepare(
      "INSERT INTO release_components (release_id, component_id) VALUES (?, ?)",
    );
    const expectationStmt = db.prepare(
      "INSERT INTO expectations (release_id, component_id, expected) VALUES (?, ?, 'Not Started')",
    );
    for (const componentId of componentIds) {
      componentStmt.run(input.releaseId, componentId);
      expectationStmt.run(input.releaseId, componentId);
    }
    const checklistStmt = db.prepare(
      "INSERT INTO release_checklist (release_id, item_id, label, done) VALUES (?, ?, ?, 0)",
    );
    for (const item of input.checklistItems) {
      checklistStmt.run(input.releaseId, item.itemId, item.label ?? null);
    }
    refreshFingerprint(db, input.releaseId);
  });
}

function requirePlanningRelease(db: DatabaseSync, releaseId: string): void {
  const row = db
    .prepare("SELECT status FROM releases WHERE release_id = ?")
    .get(releaseId) as { status: string } | undefined;
  if (!row) throw new Error(`release not found: ${releaseId}`);
  if (row.status !== "Planning") {
    throw new Error(`release ${releaseId} is ${row.status}; facts can no longer be updated`);
  }
}

function requireComponent(db: DatabaseSync, releaseId: string, componentId: string): void {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM release_components WHERE release_id = ? AND component_id = ?",
    )
    .get(releaseId, componentId);
  if (!row) {
    throw new Error(`component ${componentId} is not associated with release ${releaseId}`);
  }
}

/**
 * 应用一个批次：整体在单个事务中生效；
 * 对事实发生变化的发布（含共享组件受影响的其它发布）递增其事实版本。
 */
export function applyBatch(db: DatabaseSync, releaseId: string, batch: FactBatch): void {
  inTransaction(db, () => {
    requirePlanningRelease(db, releaseId);

    const affectedComponents = new Set<string>();

    for (const update of batch.bugUpdates ?? []) {
      requireComponent(db, releaseId, update.componentId);
      db.prepare(
        "INSERT INTO bugs (component_id, bug_id, severity, status) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (component_id, bug_id) DO UPDATE SET severity = excluded.severity, status = excluded.status",
      ).run(update.componentId, update.bugId, update.severity, update.status);
      affectedComponents.add(update.componentId);
    }

    const seqStmt = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tests WHERE release_id = ?",
    );
    const insertTest = db.prepare(
      "INSERT INTO tests (release_id, component_id, test_id, passed, total, skipped, completed_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const test of batch.tests ?? []) {
      requireComponent(db, releaseId, test.componentId);
      const seq = (seqStmt.get(releaseId) as { next: number }).next;
      insertTest.run(
        releaseId,
        test.componentId,
        test.testId,
        test.passed,
        test.total,
        test.skipped ?? 0,
        test.completedAt,
        seq,
      );
    }

    const expectationStmt = db.prepare(
      "UPDATE expectations SET expected = ? WHERE release_id = ? AND component_id = ?",
    );
    for (const update of batch.expectationUpdates ?? []) {
      requireComponent(db, releaseId, update.componentId);
      expectationStmt.run(update.expected, releaseId, update.componentId);
    }

    const checklistStmt = db.prepare(
      "UPDATE release_checklist SET done = ? WHERE release_id = ? AND item_id = ?",
    );
    for (const update of batch.checklistUpdates ?? []) {
      const result = checklistStmt.run(update.done ? 1 : 0, releaseId, update.itemId);
      if (result.changes === 0) {
        throw new Error(`checklist item not found in release ${releaseId}: ${update.itemId}`);
      }
    }

    // 受影响发布：本发布 + 共享了被更新 Bug 组件的其它发布。
    const affectedReleases = new Set<string>([releaseId]);
    if (affectedComponents.size > 0) {
      const shareStmt = db.prepare(
        "SELECT DISTINCT release_id FROM release_components WHERE component_id = ?",
      );
      for (const componentId of affectedComponents) {
        for (const row of shareStmt.all(componentId) as unknown as {
          release_id: string;
        }[]) {
          affectedReleases.add(row.release_id);
        }
      }
    }

    const beforeStmt = db.prepare(
      "SELECT fingerprint FROM releases WHERE release_id = ?",
    );
    for (const affected of affectedReleases) {
      const before = (beforeStmt.get(affected) as { fingerprint: string }).fingerprint;
      bumpVersionIfChanged(db, affected, before);
    }
  });
}
