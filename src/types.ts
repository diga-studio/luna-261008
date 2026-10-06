/** 盘点标记：已找到 / 待查 */
export type Mark = 'found' | 'pending';

/** 账册中的一台设备 */
export interface Device {
  tag: string;
  area: string;
  custodian: string;
  mark: Mark;
}

/** 盘点提交中的一条扫描记录 */
export interface ScanEntry {
  tag: string;
  area: string;
  custodian: string;
}

/** 可参与对账的字段 */
export type Field = 'area' | 'custodian' | 'mark';

/** 差异类别 */
export type DiffKind = 'missing' | 'surplus' | 'location' | 'custodian';

/** 单台设备的差异描述（基于冻结基线判定，不随当前账册变化） */
export interface DeviceDiff {
  tag: string;
  kinds: DiffKind[];
  baseline: Device;
  scanned: ScanEntry | null;
}

export type TaskStatus = 'open' | 'approved';

/** 任务结果视图 */
export interface TaskResult {
  taskId: number;
  status: TaskStatus;
  scope: string[];
  submitted: boolean;
  adjustmentId: number | null;
  diffs: DeviceDiff[];
}

export type ConflictReason = 'field-conflict' | 'missing-device-moved';

/** 审批冲突信息 */
export interface Conflict {
  tag: string;
  field: Field | null;
  reason: ConflictReason;
  baselineValue: string | null;
  currentValue: string | null;
  targetValue: string | null;
}

/** 调整单明细：只记录本次实际改变的字段及前后值 */
export interface AdjustmentItem {
  tag: string;
  field: Field;
  oldValue: string;
  newValue: string;
}

export interface Adjustment {
  id: number;
  taskId: number;
  items: AdjustmentItem[];
}

export type ApprovalResult =
  | { ok: true; adjustment: Adjustment }
  | { ok: false; conflicts: Conflict[] };
