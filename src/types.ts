/** 盘点标记 */
export type Mark = "found" | "pending";

/** 账册中一台设备的记录 */
export interface LedgerEntry {
  tag: string;
  area: string;
  custodian: string;
  mark: Mark;
}

/** 一次日常调拨 */
export interface Transfer {
  tag: string;
  area?: string;
  custodian?: string;
}

/** 盘点提交的一条扫描结果 */
export interface ScanRecord {
  tag: string;
  area: string;
  custodian: string;
}

/** 差异类型 */
export type DiffKind = "shortage" | "surplus" | "location" | "custodian";

/** 单台设备的差异项 */
export interface DiffItem {
  tag: string;
  kinds: DiffKind[];
  /** 基线值（任务开启时冻结） */
  baseline: LedgerEntry;
  /** 目标值：扫描设备为实测值+found；短缺设备仅 mark=pending */
  target: Partial<LedgerEntry>;
}

export type TaskStatus = "open" | "submitted" | "approved";

/** 盘点任务 */
export interface TaskInfo {
  id: number;
  areas: string[];
  status: TaskStatus;
  createdAt: string;
}

/** 调整单中一条字段级变更 */
export interface AdjustmentItem {
  tag: string;
  field: "area" | "custodian" | "mark";
  from: string;
  to: string;
}

/** 调整单 */
export interface Adjustment {
  id: number;
  taskId: number;
  items: AdjustmentItem[];
  createdAt: string;
}

/** 审批冲突 */
export interface ConflictItem {
  tag: string;
  field: "area" | "custodian" | "mark";
  baseline: string;
  current: string;
  target: string;
  reason: "changed" | "touched_after_open";
}

export type ApproveResult =
  | { ok: true; adjustment: Adjustment }
  | { ok: false; conflicts: ConflictItem[] };
