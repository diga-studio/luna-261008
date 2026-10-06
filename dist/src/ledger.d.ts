import type { DatabaseSync } from "node:sqlite";
import type { LedgerEntry, Transfer } from "./types.js";
/** 用调用方提供的初始账册替换当前账册（清空后写入） */
export declare function loadInitialLedger(db: DatabaseSync, entries: LedgerEntry[]): void;
/** 登记一次日常调拨：可同时改区域与保管人，盘点标记不变 */
export declare function registerTransfer(db: DatabaseSync, transfer: Transfer): void;
/** 读取整份账册（按标签排序） */
export declare function getLedger(db: DatabaseSync): LedgerEntry[];
