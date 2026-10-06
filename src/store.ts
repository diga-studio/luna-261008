import { DatabaseSync } from "node:sqlite";
import type { SessionState } from "./types.js";

interface SessionRow {
  session_id: string;
  updated_at: number;
  source_ap: string;
  source_seq: number;
  value_json: string | null;
}

function rowToState(row: SessionRow): SessionState {
  return {
    updatedAt: row.updated_at,
    sourceAp: row.source_ap,
    sourceSeq: row.source_seq,
    value: row.value_json === null ? null : (JSON.parse(row.value_json) as Record<string, unknown>),
  };
}

/**
 * SQLite-backed persistence for versions, per-version session snapshots,
 * and the global event dedup set.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dedup (
        source_ap TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        PRIMARY KEY (source_ap, source_seq)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        source_ap TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        value_json TEXT,
        PRIMARY KEY (version, session_id)
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('latest_version', '0');
    `);
  }

  /** Current latest committed version (0 = empty state). */
  getLatestVersion(): number {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'latest_version'`)
      .get() as { value: string };
    return Number(row.value);
  }

  /** Read one session's state at a version; undefined if the session is absent. */
  getSessionState(version: number, sessionId: string): SessionState | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id, updated_at, source_ap, source_seq, value_json
         FROM sessions WHERE version = ? AND session_id = ?`,
      )
      .get(version, sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : rowToState(row);
  }

  /**
   * Atomically commit a new version. The new version starts as a copy of the
   * previous version's state; `mutate` applies session writes and dedup
   * inserts via the transaction view. Returns the new version number.
   */
  commit(mutate: (txn: CommitTxn) => void): number {
    this.db.exec("BEGIN");
    try {
      const newVersion = this.getLatestVersion() + 1;
      this.db
        .prepare(
          `INSERT INTO sessions (version, session_id, updated_at, source_ap, source_seq, value_json)
           SELECT ?, session_id, updated_at, source_ap, source_seq, value_json
           FROM sessions WHERE version = ?`,
        )
        .run(newVersion, newVersion - 1);
      mutate(new SqlCommitTxn(this.db, newVersion));
      this.db
        .prepare(`UPDATE meta SET value = ? WHERE key = 'latest_version'`)
        .run(String(newVersion));
      this.db.exec("COMMIT");
      return newVersion;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Transaction-scoped view over the new version being committed. */
export interface CommitTxn {
  getSessionState(sessionId: string): SessionState | undefined;
  putSessionState(sessionId: string, state: SessionState): void;
  /** Replace the new version's entire state with the target version's state. */
  replaceAllFrom(version: number): void;
  /** Returns true if the event identity was already seen. */
  isDuplicate(sourceAp: string, sourceSeq: number): boolean;
  markSeen(sourceAp: string, sourceSeq: number): void;
}

class SqlCommitTxn implements CommitTxn {
  constructor(
    private readonly db: DatabaseSync,
    private readonly version: number,
  ) {}

  getSessionState(sessionId: string): SessionState | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id, updated_at, source_ap, source_seq, value_json
         FROM sessions WHERE version = ? AND session_id = ?`,
      )
      .get(this.version, sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : rowToState(row);
  }

  putSessionState(sessionId: string, state: SessionState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
         (version, session_id, updated_at, source_ap, source_seq, value_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.version,
        sessionId,
        state.updatedAt,
        state.sourceAp,
        state.sourceSeq,
        state.value === null ? null : JSON.stringify(state.value),
      );
  }

  isDuplicate(sourceAp: string, sourceSeq: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS seen FROM dedup WHERE source_ap = ? AND source_seq = ?`)
      .get(sourceAp, sourceSeq) as { seen: number } | undefined;
    return row !== undefined;
  }

  markSeen(sourceAp: string, sourceSeq: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO dedup (source_ap, source_seq) VALUES (?, ?)`)
      .run(sourceAp, sourceSeq);
  }

  replaceAllFrom(version: number): void {
    this.db.prepare(`DELETE FROM sessions WHERE version = ?`).run(this.version);
    this.db
      .prepare(
        `INSERT INTO sessions (version, session_id, updated_at, source_ap, source_seq, value_json)
         SELECT ?, session_id, updated_at, source_ap, source_seq, value_json
         FROM sessions WHERE version = ?`,
      )
      .run(this.version, version);
  }
}
