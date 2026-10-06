import type { BomArchive } from './archive.js';
import { type TrialInput, type TrialResult } from './types.js';
/** 最大展开层数（根件为第 1 层） */
export declare const MAX_LEVEL = 12;
/**
 * 执行一次多级 BOM 需求试算。
 * 失败时抛出 TrialError，不返回部分结果。
 */
export declare function runTrial(archive: BomArchive, input: TrialInput): TrialResult;
