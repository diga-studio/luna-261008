export * from "./types.js";
import { openDatabase } from "./db.js";
import { getLedger, loadInitialLedger, registerTransfer } from "./ledger.js";
import { getDiffs, getTask, openTask, submitResults } from "./tasks.js";
import { approveTask, getAdjustment } from "./approval.js";
/** 工业设备盘点对账库主入口 */
export class InventoryReconciliation {
    db;
    constructor(dbPath) {
        this.db = openDatabase(dbPath);
    }
    /** 用调用方提供的初始账册替换当前账册 */
    loadInitialLedger(entries) {
        loadInitialLedger(this.db, entries);
    }
    /** 登记日常调拨 */
    registerTransfer(transfer) {
        registerTransfer(this.db, transfer);
    }
    /** 查看整份账册 */
    getLedger() {
        return getLedger(this.db);
    }
    /** 开启盘点任务（指定区域范围，冻结基线） */
    openTask(areas) {
        return openTask(this.db, areas);
    }
    /** 提交整份盘点结果 */
    submitResults(taskId, records) {
        submitResults(this.db, taskId, records);
    }
    /** 查看任务信息 */
    getTask(taskId) {
        return getTask(this.db, taskId);
    }
    /** 查看任务差异清单 */
    getDiffs(taskId) {
        return getDiffs(this.db, taskId);
    }
    /** 审批对账 */
    approveTask(taskId) {
        return approveTask(this.db, taskId);
    }
    /** 查看任务调整单 */
    getAdjustment(taskId) {
        return getAdjustment(this.db, taskId);
    }
    /** 关闭数据库 */
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=index.js.map