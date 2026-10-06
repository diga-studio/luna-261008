import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import type { JsonObject, SessionEvent, WinnerInfo } from "./types.js";

type SessionStatus = "value" | "deleted" | "absent";

interface MaterializedState {
  status: SessionStatus;
  winner: WinnerInfo | null;
  valueJson: string | null;
}

const ABSENT_STATE: MaterializedState = {
  status: "absent",
  winner: null,
  valueJson: null,
};

interface SessionRow {
  session_id: string;
  status: string;
  source_ap: string | null;
  source_seq: number | null;
  updated_at: number | null;
  value_json: string | null;
}

function rowToState(row: SessionRow): MaterializedState {
  if (row.status === "absent") {
    return ABSENT_STATE;
  }
  return {
    status: row.status as SessionStatus,
    winner: {
      sourceAp: row.source_ap as string,
      sourceSeq: row.source_seq as number,
      updatedAt: row.updated_at as number,
    },
    valueJson: row.value_json,
  };
}

function statesEqual(a: MaterializedState, b: MaterializedState): boolean {
  if (a.status !== b.status || a.valueJson !== b.valueJson) {
    return false;
  }
  if (a.winner === null || b.winner === null) {
    return a.winner === b.winner;
  }
  return (
    a.winner.sourceAp === b.winner.sourceAp &&
    a.winner.sourceSeq === b.winner.sourceSeq &&
    a.winner.updatedAt === b.winner.updatedAt
  );
}

function eventBeatsWinner(event: SessionEvent, winner: WinnerInfo): boolean {
  if (event.updatedAt !== winner.updatedAt) {
    return event.updatedAt > winner.updatedAt;
  }
  if (event.sourceAp !== winner.sourceAp) {
    return event.sourceAp > winner.sourceAp;
  }
  return event.sourceSeq > winner.sourceSeq;
}

export class GuestConnectStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = openDatabase(path);
  }

  merge(events: SessionEvent[]): number {
    const version = this.currentVersion() + 1;
    this.db.exec("BEGIN");
    try {
      const seenStmt = this.db.prepare(
        "SELECT 1 AS x FROM seen_events WHERE source_ap = ? AND source_seq = ?",
      );
      const markSeenStmt = this.db.prepare(
        "INSERT INTO seen_events (source_ap, source_seq) VALUES (?, ?)",
      );
      const currentStmt = this.db.prepare(
        "SELECT * FROM sessions WHERE session_id = ?",
      );
      const upsertStmt = this.db.prepare(
        `INSERT INTO sessions (session_id, status, source_ap, source_seq, updated_at, value_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           status = excluded.status,
           source_ap = excluded.source_ap,
           source_seq = excluded.source_seq,
           updated_at = excluded.updated_at,
           value_json = excluded.value_json`,
      );
      const historyStmt = this.db.prepare(
        `INSERT OR REPLACE INTO session_history
           (session_id, version, status, source_ap, source_seq, updated_at, value_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const event of events) {
        if (seenStmt.get(event.sourceAp, event.sourceSeq) !== undefined) {
          continue;
        }
        markSeenStmt.run(event.sourceAp, event.sourceSeq);

        const row = currentStmt.get(event.sessionId) as
          | SessionRow
          | undefined;
        if (row !== undefined) {
          const current = rowToState(row);
          if (
            current.winner !== null &&
            !eventBeatsWinner(event, current.winner)
          ) {
            continue;
          }
        }

        const status: SessionStatus = event.kind === "delete" ? "deleted" : "value";
        const valueJson = event.kind === "value" ? JSON.stringify(event.value) : null;
        upsertStmt.run(
          event.sessionId,
          status,
          event.sourceAp,
          event.sourceSeq,
          event.updatedAt,
          valueJson,
        );
        historyStmt.run(
          event.sessionId,
          version,
          status,
          event.sourceAp,
          event.sourceSeq,
          event.updatedAt,
          valueJson,
        );
      }

      this.db
        .prepare("INSERT INTO versions (version, created_at) VALUES (?, ?)")
        .run(version, Date.now());
      this.db.exec("COMMIT");
      return version;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(version: number, sessionId: string): JsonObject | undefined {
    this.assertValidVersion(version);
    const row = this.db
      .prepare(
        `SELECT * FROM session_history
         WHERE session_id = ? AND version <= ?
         ORDER BY version DESC
         LIMIT 1`,
      )
      .get(sessionId, version) as SessionRow | undefined;
    if (row === undefined || row.status !== "value" || row.value_json === null) {
      return undefined;
    }
    return JSON.parse(row.value_json) as JsonObject;
  }

  rollback(version: number): number {
    this.assertValidVersion(version);
    const newVersion = this.currentVersion() + 1;
    this.db.exec("BEGIN");
    try {
      const targetRows = this.db
        .prepare(
          `SELECT h.* FROM session_history h
           JOIN (
             SELECT session_id, MAX(version) AS v
             FROM session_history
             WHERE version <= ?
             GROUP BY session_id
           ) t ON h.session_id = t.session_id AND h.version = t.v`,
        )
        .all(version) as unknown as SessionRow[];
      const targetStates = new Map<string, MaterializedState>();
      for (const row of targetRows) {
        targetStates.set(row.session_id, rowToState(row));
      }

      const currentRows = this.db
        .prepare("SELECT * FROM sessions")
        .all() as unknown as SessionRow[];
      const currentStates = new Map<string, MaterializedState>();
      for (const row of currentRows) {
        currentStates.set(row.session_id, rowToState(row));
      }

      const sessionIds = new Set<string>([
        ...targetStates.keys(),
        ...currentStates.keys(),
      ]);

      const upsertStmt = this.db.prepare(
        `INSERT INTO sessions (session_id, status, source_ap, source_seq, updated_at, value_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           status = excluded.status,
           source_ap = excluded.source_ap,
           source_seq = excluded.source_seq,
           updated_at = excluded.updated_at,
           value_json = excluded.value_json`,
      );
      const deleteStmt = this.db.prepare(
        "DELETE FROM sessions WHERE session_id = ?",
      );
      const historyStmt = this.db.prepare(
        `INSERT INTO session_history
           (session_id, version, status, source_ap, source_seq, updated_at, value_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const sessionId of sessionIds) {
        const target = targetStates.get(sessionId) ?? ABSENT_STATE;
        const current = currentStates.get(sessionId) ?? ABSENT_STATE;
        if (statesEqual(target, current)) {
          continue;
        }
        if (target.status === "absent") {
          deleteStmt.run(sessionId);
          historyStmt.run(sessionId, newVersion, "absent", null, null, null, null);
        } else {
          const winner = target.winner as WinnerInfo;
          upsertStmt.run(
            sessionId,
            target.status,
            winner.sourceAp,
            winner.sourceSeq,
            winner.updatedAt,
            target.valueJson,
          );
          historyStmt.run(
            sessionId,
            newVersion,
            target.status,
            winner.sourceAp,
            winner.sourceSeq,
            winner.updatedAt,
            target.valueJson,
          );
        }
      }

      this.db
        .prepare("INSERT INTO versions (version, created_at) VALUES (?, ?)")
        .run(newVersion, Date.now());
      this.db.exec("COMMIT");
      return newVersion;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  currentVersion(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM versions")
      .get() as { v: number };
    return row.v;
  }

  close(): void {
    this.db.close();
  }

  private assertValidVersion(version: number): void {
    if (
      !Number.isInteger(version) ||
      version < 0 ||
      version > this.currentVersion()
    ) {
      throw new RangeError(`invalid version: ${version}`);
    }
  }
}
