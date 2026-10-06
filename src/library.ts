import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ContentMismatchError,
  TokenExpiredError,
  UnknownTokenError,
} from "./types.ts";
import type {
  ByteSource,
  CreateTokenResult,
  LibraryOptions,
  ReadResult,
} from "./types.ts";

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface TokenRow {
  token: string;
  application_id: string;
  status: "pending" | "submitted";
  expires_at: number;
  content_hash: string | null;
  file_path: string | null;
}

export class RecommendationLetterLibrary {
  private readonly db: DatabaseSync;
  private readonly filesDir: string;
  private readonly clock: () => number;

  constructor(options: LibraryOptions) {
    this.filesDir = options.filesDir;
    this.clock = options.clock;
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'submitted')),
        expires_at INTEGER NOT NULL,
        content_hash TEXT,
        file_path TEXT
      )
    `);
  }

  createToken(applicationId: string): CreateTokenResult {
    const token = randomUUID();
    const expiresAt = this.clock() + TOKEN_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO tokens (token, application_id, status, expires_at)
         VALUES (?, ?, 'pending', ?)`,
      )
      .run(token, applicationId, expiresAt);
    return { token, expiresAt };
  }

  async submit(token: string, source: ByteSource): Promise<void> {
    const row = this.lookup(token);

    // 完整接收输入；中途失败直接抛出，不触碰任何状态。
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);

    if (row.status === "submitted") {
      // 已提交的推荐信不可变：逐字节相同则幂等成功（即使已过期），
      // 不同则拒绝且不改变原信件。
      const stored = readFileSync(row.file_path!);
      if (stored.length === content.length && stored.equals(content)) {
        return;
      }
      throw new ContentMismatchError();
    }

    // 有效期在完整接收之后、写入 submitted 之前判定，严格早于到期时间。
    if (!(this.clock() < row.expires_at)) {
      throw new TokenExpiredError();
    }

    const hash = createHash("sha256").update(content).digest("hex");
    const filePath = join(this.filesDir, `${token}.pdf`);
    const tmpPath = join(this.filesDir, `${token}.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);

    const result = this.db
      .prepare(
        `UPDATE tokens
         SET status = 'submitted', content_hash = ?, file_path = ?
         WHERE token = ? AND status = 'pending'`,
      )
      .run(hash, filePath, token);
    if (result.changes !== 1) {
      throw new Error(`failed to mark token as submitted: ${token}`);
    }
  }

  read(token: string): ReadResult {
    const row = this.lookup(token);
    if (row.status === "submitted") {
      // 已提交的 token 不再随时间变为 expired。
      return {
        status: "submitted",
        stream: createReadStream(row.file_path!),
      };
    }
    return this.clock() < row.expires_at
      ? { status: "pending" }
      : { status: "expired" };
  }

  close(): void {
    this.db.close();
  }

  private lookup(token: string): TokenRow {
    const row = this.db
      .prepare(`SELECT * FROM tokens WHERE token = ?`)
      .get(token) as TokenRow | undefined;
    if (!row) {
      throw new UnknownTokenError(token);
    }
    return row;
  }
}
