/** 注入的时钟，返回 UTC 毫秒。 */
export type Clock = () => number;

/** 一次性异步字节流输入。 */
export type ByteSource = AsyncIterable<Uint8Array>;

export type TokenStatus = "pending" | "submitted" | "expired";

export interface CreateTokenResult {
  token: string;
  /** 创建后 14 天的到期时间（UTC 毫秒）。 */
  expiresAt: number;
}

export interface ReadPendingResult {
  status: "pending";
}

export interface ReadExpiredResult {
  status: "expired";
}

export interface ReadSubmittedResult {
  status: "submitted";
  /** 原始信件字节的可读流。 */
  stream: NodeJS.ReadableStream;
}

export type ReadResult =
  | ReadPendingResult
  | ReadExpiredResult
  | ReadSubmittedResult;

export interface LibraryOptions {
  /** SQLite 数据库文件路径。 */
  dbPath: string;
  /** PDF 字节保存目录。 */
  filesDir: string;
  clock: Clock;
}

export class UnknownTokenError extends Error {
  constructor(token: string) {
    super(`unknown token: ${token}`);
    this.name = "UnknownTokenError";
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super("token has expired");
    this.name = "TokenExpiredError";
  }
}

export class ContentMismatchError extends Error {
  constructor() {
    super("submitted content differs from the letter on record");
    this.name = "ContentMismatchError";
  }
}
