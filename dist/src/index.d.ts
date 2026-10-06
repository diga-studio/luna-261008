export * from "./types.js";
import type { Adjustment, ApproveResult, DiffItem, LedgerEntry, ScanRecord, TaskInfo, Transfer } from "./types.js";
/** 工业设备盘点对账库主入口 */
export declare class InventoryReconciliation {
    private readonly db;
    constructor(dbPath: string);
    /** 用调用方提供的初始账册替换当前账册 */
    loadInitialLedger(entries: LedgerEntry[]): void;
    /** 登记日常调拨 */
    registerTransfer(transfer: Transfer): void;
    /** 查看整份账册 */
    getLedger(): LedgerEntry[];
    /** 开启盘点任务（指定区域范围，冻结基线） */
    openTask(areas: string[]): TaskInfo;
    /** 提交整份盘点结果 */
    submitResults(taskId: number, records: ScanRecord[]): void;
    /** 查看任务信息 */
    getTask(taskId: number): TaskInfo;
    /** 查看任务差异清单 */
    getDiffs(taskId: number): DiffItem[];
    /** 审批对账 */
    approveTask(taskId: number): ApproveResult;
    /** 查看任务调整单 */
    getAdjustment(taskId: number): Adjustment | null;
    /** 关闭数据库 */
    close(): void;
}
