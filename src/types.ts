/** 固定块大小：4 MiB，末块允许更短。 */
export const BLOCK_SIZE = 4 * 1024 * 1024;

/** 清单中一个版本内按文件顺序排列的块引用。 */
export interface BlockRef {
  /** 块正文的 SHA-256（小写十六进制，64 字符）。 */
  readonly hash: string;
  /** 块长度（字节），除末块外应等于 BLOCK_SIZE。 */
  readonly length: number;
}

/** 清单中的一个版本。 */
export interface VersionEntry {
  /** 版本标识。 */
  readonly id: string;
  /** 按文件顺序排列的块引用。 */
  readonly blocks: readonly BlockRef[];
}

/** 报告中的一条损坏记录：一个坏块及其受影响版本（去重）。 */
export interface CorruptionEntry {
  readonly hash: string;
  /** 清单声明的期望长度。 */
  readonly length: number;
  /** 受影响版本标识，按字典序排列，同一版本只出现一次。 */
  readonly versions: readonly string[];
}

/** 损坏报告。只有完整校验结束后才会整体替换。 */
export interface CorruptionReport {
  /** 报告生成时间（ISO 8601）；从未完成过校验时为 null。 */
  readonly generatedAt: string | null;
  /** 损坏块列表，按哈希字典序排列。 */
  readonly entries: readonly CorruptionEntry[];
  /** 仍含损坏块的版本标识，按字典序排列。 */
  readonly damagedVersions: readonly string[];
}

/** 空报告（仓库尚未完成任何完整校验时的默认报告）。 */
export const EMPTY_REPORT: CorruptionReport = {
  generatedAt: null,
  entries: [],
  damagedVersions: [],
};

/** 导入时的初始块数据。 */
export interface BlockInput {
  readonly hash: string;
  readonly data: Uint8Array;
}

/** 修复成功后的结果。 */
export interface RepairResult {
  readonly hash: string;
  /** 本次提交是否真正改写了块文件（重复提交正确数据时为 false，但语义相同）。 */
  readonly blockRewritten: boolean;
}

/** 补传被拒绝时抛出的错误；拒绝不会改变原有块与报告。 */
export class RepairRejectedError extends Error {
  readonly reason: "unknown-hash" | "length-mismatch" | "hash-mismatch";
  constructor(reason: RepairRejectedError["reason"], message: string) {
    super(message);
    this.name = "RepairRejectedError";
    this.reason = reason;
  }
}

/** 测试/诊断用的崩溃注入钩子：在修复流程的关键步骤之间触发。 */
export interface RepairHooks {
  /** 修复日志（journal）落盘之后、块文件提交之前。 */
  afterJournalWrite?: (() => void) | undefined;
  /** 新块文件原子提交之后、报告更新之前。 */
  afterBlockCommit?: (() => void) | undefined;
  /** 报告原子替换之后、日志删除之前。 */
  afterReportSave?: (() => void) | undefined;
}

/** 测试/诊断用的校验钩子。 */
export interface VerifyHooks {
  /** 校验完成、新报告原子替换之前。 */
  beforeReportSave?: (() => void) | undefined;
}

/** 打开仓库时的可选注入（用于测试崩溃恢复）。 */
export interface OpenOptions {
  readonly repairHooks?: RepairHooks | undefined;
  readonly verifyHooks?: VerifyHooks | undefined;
}

/** 读取统计：用于验证恢复过程的正文读取量上限。 */
export interface ReadStats {
  /** 自打开以来读取的块正文字节总量（校验与恢复哈希计算）。 */
  blockBytesRead: number;
}
