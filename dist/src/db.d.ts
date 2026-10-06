import { DatabaseSync } from "node:sqlite";
/** 打开（或创建）SQLite 数据库并初始化表结构 */
export declare function openDatabase(path: string): DatabaseSync;
/** 在 IMMEDIATE 事务中执行 fn，保证整体可见、失败回滚 */
export declare function withTransaction<T>(db: DatabaseSync, fn: () => T): T;
