import type { DatabaseSync } from "node:sqlite";
import type {
  Adjustment,
  AdjustmentItem,
  ApproveResult,
  ConflictItem,
} from "./types.js";
import { withTransaction } from "./db.js";
import { getDiffs } from "./tasks.js";

type Field = "area" | "custodian" | "mark";

interface TaskRow {
  id: number;
  status: string;
  baseline_seq: number;
}

interface LedgerRow {
  tag: string;
  area: string;
  custodian: string;
  mark: string;
}

function loadAdjustment(db: DatabaseSync, taskId: number): Adjustment | null {
  const head = db
    .prepare("SELECT id, task_id, created_at FROM adjustments WHERE task_id = ?")
    .get(taskId) as { id: number; task_id: number; created_at: string } | undefined;
  if (!head) return null;
  const items = db
    .prepare(
      "SELECT tag, field, from_value, to_value FROM adjustment_items WHERE adjustment_id = ? ORDER BY tag, field",
    )
    .all(head.id) as unknown as {
    tag: string;
    field: string;
    from_value: string;
    to_value: string;
  }[];
  return {
    id: head.id,
    taskId: head.task_id,
    createdAt: head.created_at,
    items: items.map((item) => ({
      tag: item.tag,
      field: item.field as Field,
      from: item.from_value,
      to: item.to_value,
    })),
  };
}

/** 审批对账：全部通过才落账并生成唯一调整单；已成功任务返回原调整单 */
export function approveTask(db: DatabaseSync, taskId: number): ApproveResult {
  return withTransaction(db, () => {
    const task = db
      .prepare("SELECT id, status, baseline_seq FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    if (task.status === "approved") {
      const existing = loadAdjustment(db, taskId);
      if (!existing) {
        throw new Error(`任务 ${taskId} 状态异常：已审批但无调整单`);
      }
      return { ok: true, adjustment: existing };
    }
    if (task.status !== "submitted") {
      throw new Error(`任务 ${taskId} 尚未提交盘点结果，不能审批`);
    }

    const conflicts: ConflictItem[] = [];
    const changes: AdjustmentItem[] = [];
    const getCurrent = db.prepare(
      "SELECT tag, area, custodian, mark FROM ledger WHERE tag = ?",
    );
    const touchedStmt = db.prepare(
      `SELECT 1 AS one FROM op_log
       WHERE tag = ? AND field IN ('area','custodian') AND seq > ? LIMIT 1`,
    );

    for (const diff of getDiffs(db, taskId)) {
      const current = getCurrent.get(diff.tag) as LedgerRow | undefined;
      if (!current) {
        throw new Error(`设备不存在: ${diff.tag}`);
      }
      const isShortage = diff.kinds.includes("shortage");
      if (isShortage) {
        // 短缺项额外依赖：任务开启后区域/保管人曾实际变化即冲突，优先于字段收敛规则
        const touched = touchedStmt.get(diff.tag, task.baseline_seq);
        if (touched) {
          conflicts.push({
            tag: diff.tag,
            field: "mark",
            baseline: diff.baseline.mark,
            current: current.mark,
            target: "pending",
            reason: "touched_after_open",
          });
          continue;
        }
      }
      for (const field of ["area", "custodian", "mark"] as Field[]) {
        const targetValue = diff.target[field];
        if (targetValue === undefined) continue;
        const baselineValue = diff.baseline[field];
        if (targetValue === baselineValue) continue; // 未参与修改的字段
        const currentValue = current[field];
        if (currentValue === baselineValue) {
          changes.push({ tag: diff.tag, field, from: currentValue, to: targetValue });
        } else if (currentValue === targetValue) {
          // 已收敛，不重复修改
        } else {
          conflicts.push({
            tag: diff.tag,
            field,
            baseline: baselineValue,
            current: currentValue,
            target: targetValue,
            reason: "changed",
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return { ok: false, conflicts };
    }

    const updateStmt = {
      area: db.prepare("UPDATE ledger SET area = ? WHERE tag = ?"),
      custodian: db.prepare("UPDATE ledger SET custodian = ? WHERE tag = ?"),
      mark: db.prepare("UPDATE ledger SET mark = ? WHERE tag = ?"),
    } as Record<Field, ReturnType<DatabaseSync["prepare"]>>;
    const logStmt = db.prepare(
      "INSERT INTO op_log (tag, field, old_value, new_value, source, task_id) VALUES (?, ?, ?, ?, 'approval', ?)",
    );
    for (const change of changes) {
      updateStmt[change.field].run(change.to, change.tag);
      logStmt.run(change.tag, change.field, change.from, change.to, taskId);
    }

    const createdAt = new Date().toISOString();
    const inserted = db
      .prepare("INSERT INTO adjustments (task_id, created_at) VALUES (?, ?)")
      .run(taskId, createdAt);
    const adjustmentId = Number(inserted.lastInsertRowid);
    const itemStmt = db.prepare(
      "INSERT INTO adjustment_items (adjustment_id, tag, field, from_value, to_value) VALUES (?, ?, ?, ?, ?)",
    );
    for (const change of changes) {
      itemStmt.run(adjustmentId, change.tag, change.field, change.from, change.to);
    }
    db.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run(taskId);

    const adjustment = loadAdjustment(db, taskId);
    if (!adjustment) {
      throw new Error("调整单生成失败");
    }
    return { ok: true, adjustment };
  });
}

/** 查看任务对应的调整单（未生成时返回 null） */
export function getAdjustment(db: DatabaseSync, taskId: number): Adjustment | null {
  return loadAdjustment(db, taskId);
}
