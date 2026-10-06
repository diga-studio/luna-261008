/** 记录结构损坏（扇区尾保护、截断、越界等），不得产出候选或文件。 */
export class CorruptRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptRecordError";
  }
}

/** 文件形式明确不支持（压缩、加密、扩展记录、命名流等）。 */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

/** 记录或簇不满足可恢复条件（记录仍被使用、簇已被占用）。 */
export class NotRecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRecoverableError";
  }
}
