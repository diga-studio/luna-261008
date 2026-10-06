import type { DatabaseSync } from "node:sqlite";
import type { Adjustment, ApproveResult } from "./types.js";
/** 审批对账：全部通过才落账并生成唯一调整单；已成功任务返回原调整单 */
export declare function approveTask(db: DatabaseSync, taskId: number): ApproveResult;
/** 查看任务对应的调整单（未生成时返回 null） */
export declare function getAdjustment(db: DatabaseSync, taskId: number): Adjustment | null;
