import { DatabaseSync } from "node:sqlite";

export interface TokenRow {
  token: string;
  applicationId: string;
  status: "pending" | "submitted";
  createdAt: number;
  expiresAt: number;
  contentHash: string | null;
  fileName: string | null;
}

/** SQLite-backed metadata store for letter tokens. */
export class MetadataStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS letter_tokens (
        token TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'submitted')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        content_hash TEXT,
        file_name TEXT
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  insertToken(row: TokenRow): void {
    this.db
      .prepare(
        `INSERT INTO letter_tokens
           (token, application_id, status, created_at, expires_at, content_hash, file_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.token,
        row.applicationId,
        row.status,
        row.createdAt,
        row.expiresAt,
        row.contentHash,
        row.fileName,
      );
  }

  getToken(token: string): TokenRow | null {
    const row = this.db
      .prepare(
        `SELECT token, application_id, status, created_at, expires_at, content_hash, file_name
           FROM letter_tokens WHERE token = ?`,
      )
      .get(token) as
      | {
          token: string;
          application_id: string;
          status: "pending" | "submitted";
          created_at: number;
          expires_at: number;
          content_hash: string | null;
          file_name: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      token: row.token,
      applicationId: row.application_id,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      contentHash: row.content_hash,
      fileName: row.file_name,
    };
  }

  markSubmitted(token: string, contentHash: string, fileName: string): void {
    this.db
      .prepare(
        `UPDATE letter_tokens
           SET status = 'submitted', content_hash = ?, file_name = ?
         WHERE token = ? AND status = 'pending'`,
      )
      .run(contentHash, fileName, token);
  }
}
