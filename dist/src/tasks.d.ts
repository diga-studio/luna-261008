import type { DatabaseSync } from "node:sqlite";
import type { DiffItem, ScanRecord, TaskInfo } from "./types.js";
/** 开启盘点任务：在同一事务中冻结当前整份账册为基线 */
export declare function openTask(db: DatabaseSync, areas: string[]): TaskInfo;
/** 提交整份盘点结果，提交后固定，不再编辑 */
export declare function submitResults(db: DatabaseSync, taskId: number, records: ScanRecord[]): void;
/** 查看任务信息 */
export declare function getTask(db: DatabaseSync, taskId: number): TaskInfo;
/** 计算任务的差异清单（基于冻结基线与提交结果，不随当前账册变化） */
export declare function getDiffs(db: DatabaseSync, taskId: number): DiffItem[];
