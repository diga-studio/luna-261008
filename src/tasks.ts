import type { DatabaseSync } from "node:sqlite";
import type { DiffItem, LedgerEntry, Mark, ScanRecord, TaskInfo, TaskStatus } from "./types.js";
import { withTransaction } from "./db.js";

interface TaskRow {
  id: number;
  areas: string;
  status: string;
  created_at: string;
}

interface BaselineRow {
  tag: string;
  area: string;
  custodian: string;
  mark: string;
}

function rowToTask(row: TaskRow): TaskInfo {
  return {
    id: row.id,
    areas: JSON.parse(row.areas) as string[],
    status: row.status as TaskStatus,
    createdAt: row.created_at,
  };
}

function getTaskRow(db: DatabaseSync, taskId: number): TaskRow {
  const row = db.prepare("SELECT id, areas, status, created_at FROM tasks WHERE id = ?").get(taskId) as
    | TaskRow
    | undefined;
  if (!row) {
    throw new Error(`任务不存在: ${taskId}`);
  }
  return row;
}

/** 开启盘点任务：在同一事务中冻结当前整份账册为基线 */
export function openTask(db: DatabaseSync, areas: string[]): TaskInfo {
  if (areas.length === 0) {
    throw new Error("盘点任务必须指定至少一个区域");
  }
  return withTransaction(db, () => {
    const seqRow = db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM op_log").get() as {
      max_seq: number;
    };
    const createdAt = new Date().toISOString();
    const result = db
      .prepare("INSERT INTO tasks (areas, status, baseline_seq, created_at) VALUES (?, 'open', ?, ?)")
      .run(JSON.stringify(areas), seqRow.max_seq, createdAt);
    const taskId = Number(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO baselines (task_id, tag, area, custodian, mark)
       SELECT ?, tag, area, custodian, mark FROM ledger`,
    ).run(taskId);
    return getTask(db, taskId);
  });
}

/** 提交整份盘点结果，提交后固定，不再编辑 */
export function submitResults(db: DatabaseSync, taskId: number, records: ScanRecord[]): void {
  withTransaction(db, () => {
    const task = getTaskRow(db, taskId);
    if (task.status !== "open") {
      throw new Error(`任务 ${taskId} 已提交，结果固定不可编辑`);
    }
    const scope = new Set(JSON.parse(task.areas) as string[]);
    const seen = new Set<string>();
    const exists = db.prepare("SELECT 1 AS one FROM ledger WHERE tag = ?");
    const insert = db.prepare(
      "INSERT INTO submissions (task_id, tag, area, custodian) VALUES (?, ?, ?, ?)",
    );
    for (const record of records) {
      if (seen.has(record.tag)) {
        throw new Error(`提交结果包含重复标签: ${record.tag}`);
      }
      seen.add(record.tag);
      if (!exists.get(record.tag)) {
        throw new Error(`扫描标签未登记: ${record.tag}`);
      }
      if (!scope.has(record.area)) {
        throw new Error(`实测区域不在任务范围内: ${record.area}`);
      }
      insert.run(taskId, record.tag, record.area, record.custodian);
    }
    db.prepare("UPDATE tasks SET status = 'submitted' WHERE id = ?").run(taskId);
  });
}

/** 查看任务信息 */
export function getTask(db: DatabaseSync, taskId: number): TaskInfo {
  return rowToTask(getTaskRow(db, taskId));
}

/** 计算任务的差异清单（基于冻结基线与提交结果，不随当前账册变化） */
export function getDiffs(db: DatabaseSync, taskId: number): DiffItem[] {
  const task = getTaskRow(db, taskId);
  const scope = new Set(JSON.parse(task.areas) as string[]);
  const baselineRows = db
    .prepare("SELECT tag, area, custodian, mark FROM baselines WHERE task_id = ?")
    .all(taskId) as unknown as BaselineRow[];
  const baselineByTag = new Map<string, LedgerEntry>();
  for (const row of baselineRows) {
    baselineByTag.set(row.tag, {
      tag: row.tag,
      area: row.area,
      custodian: row.custodian,
      mark: row.mark as Mark,
    });
  }
  const scannedRows = db
    .prepare("SELECT tag, area, custodian FROM submissions WHERE task_id = ?")
    .all(taskId) as unknown as { tag: string; area: string; custodian: string }[];
  const scannedByTag = new Map(scannedRows.map((row) => [row.tag, row]));

  const diffs: DiffItem[] = [];
  for (const baseline of baselineByTag.values()) {
    const scanned = scannedByTag.get(baseline.tag);
    const inScope = scope.has(baseline.area);
    if (!scanned) {
      if (inScope && baseline.mark !== "pending") {
        diffs.push({
          tag: baseline.tag,
          kinds: ["shortage"],
          baseline,
          target: { mark: "pending" },
        });
      }
      continue;
    }
    const target: Partial<LedgerEntry> = {
      area: scanned.area,
      custodian: scanned.custodian,
      mark: "found",
    };
    if (!inScope) {
      diffs.push({ tag: baseline.tag, kinds: ["surplus"], baseline, target });
      continue;
    }
    const kinds: DiffItem["kinds"] = [];
    if (scanned.area !== baseline.area) kinds.push("location");
    if (scanned.custodian !== baseline.custodian) kinds.push("custodian");
    const markDiffers = baseline.mark !== "found";
    if (kinds.length > 0 || markDiffers) {
      diffs.push({ tag: baseline.tag, kinds, baseline, target });
    }
  }
  return diffs.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}
