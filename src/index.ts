export * from "./types.js";

import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import { getLedger, loadInitialLedger, registerTransfer } from "./ledger.js";
import { getDiffs, getTask, openTask, submitResults } from "./tasks.js";
import { approveTask, getAdjustment } from "./approval.js";
import type {
  Adjustment,
  ApproveResult,
  DiffItem,
  LedgerEntry,
  ScanRecord,
  TaskInfo,
  Transfer,
} from "./types.js";

/** 工业设备盘点对账库主入口 */
export class InventoryReconciliation {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 用调用方提供的初始账册替换当前账册 */
  loadInitialLedger(entries: LedgerEntry[]): void {
    loadInitialLedger(this.db, entries);
  }

  /** 登记日常调拨 */
  registerTransfer(transfer: Transfer): void {
    registerTransfer(this.db, transfer);
  }

  /** 查看整份账册 */
  getLedger(): LedgerEntry[] {
    return getLedger(this.db);
  }

  /** 开启盘点任务（指定区域范围，冻结基线） */
  openTask(areas: string[]): TaskInfo {
    return openTask(this.db, areas);
  }

  /** 提交整份盘点结果 */
  submitResults(taskId: number, records: ScanRecord[]): void {
    submitResults(this.db, taskId, records);
  }

  /** 查看任务信息 */
  getTask(taskId: number): TaskInfo {
    return getTask(this.db, taskId);
  }

  /** 查看任务差异清单 */
  getDiffs(taskId: number): DiffItem[] {
    return getDiffs(this.db, taskId);
  }

  /** 审批对账 */
  approveTask(taskId: number): ApproveResult {
    return approveTask(this.db, taskId);
  }

  /** 查看任务调整单 */
  getAdjustment(taskId: number): Adjustment | null {
    return getAdjustment(this.db, taskId);
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
  }
}
