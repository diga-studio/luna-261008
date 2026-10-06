import type { ObjectInfo, Tier } from "./types";
import { DatabaseSync } from "node:sqlite";
import { CapacityExceededError } from "./types";

/** A committed, readable object record. */
export interface ObjectRow extends ObjectInfo {
  fileName: string;
}

/** A capacity hold: full-size reservation for an in-flight put or migration. */
export interface ReservationRow {
  id: string;
  tier: Tier;
  sizeBytes: number;
  /** 'put' | 'migration' */
  kind: string;
  /** For migrations: the object being moved. */
  objectId: string | null;
  /** Temporary file name in the tier directory. */
  tmpName: string;
}

/**
 * SQLite-backed persistence for object metadata, capacity usage and
 * in-flight reservations. All mutating multi-step operations run inside
 * transactions so a crash never leaves half-applied accounting.
 */
export class MetadataDb {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        file_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        kind TEXT NOT NULL,
        object_id TEXT,
        tmp_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Sum of committed object bytes per tier. */
  usedBytes(tier: Tier): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM objects WHERE tier = ?")
      .get(tier) as { total: number };
    return row.total;
  }

  /** Sum of reserved bytes per tier. */
  reservedBytes(tier: Tier): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM reservations WHERE tier = ?")
      .get(tier) as { total: number };
    return row.total;
  }

  getObject(id: string): ObjectRow | null {
    const row = this.db
      .prepare("SELECT id, tier, size_bytes, sha256, file_name FROM objects WHERE id = ?")
      .get(id) as
      | { id: string; tier: Tier; size_bytes: number; sha256: string; file_name: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      tier: row.tier,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      fileName: row.file_name,
    };
  }

  listObjects(): ObjectRow[] {
    const rows = this.db
      .prepare("SELECT id, tier, size_bytes, sha256, file_name FROM objects")
      .all() as Array<{
      id: string;
      tier: Tier;
      size_bytes: number;
      sha256: string;
      file_name: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      tier: row.tier,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      fileName: row.file_name,
    }));
  }

  /**
   * Atomically check capacity and insert a reservation row.
   * Throws CapacityExceededError when the reservation would exceed capacity.
   */
  createReservation(input: {
    id: string;
    tier: Tier;
    sizeBytes: number;
    kind: string;
    objectId: string | null;
    tmpName: string;
    capacityBytes: number;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.usedBytes(input.tier);
      const reserved = this.reservedBytes(input.tier);
      if (used + reserved + input.sizeBytes > input.capacityBytes) {
        throw new CapacityExceededError(
          `tier ${input.tier} capacity exceeded: used=${used} reserved=${reserved} ` +
            `requested=${input.sizeBytes} capacity=${input.capacityBytes}`,
        );
      }
      this.db
        .prepare(
          "INSERT INTO reservations (id, tier, size_bytes, kind, object_id, tmp_name) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.id,
          input.tier,
          input.sizeBytes,
          input.kind,
          input.objectId,
          input.tmpName,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteReservation(id: string): void {
    this.db.prepare("DELETE FROM reservations WHERE id = ?").run(id);
  }

  listReservations(): ReservationRow[] {
    const rows = this.db
      .prepare("SELECT id, tier, size_bytes, kind, object_id, tmp_name FROM reservations")
      .all() as Array<{
      id: string;
      tier: Tier;
      size_bytes: number;
      kind: string;
      object_id: string | null;
      tmp_name: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      tier: row.tier,
      sizeBytes: row.size_bytes,
      kind: row.kind,
      objectId: row.object_id,
      tmpName: row.tmp_name,
    }));
  }

  /**
   * Finalize a successful put: insert the object row and drop the
   * reservation in one transaction.
   */
  finalizePut(reservationId: string, object: ObjectRow): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO objects (id, tier, size_bytes, sha256, file_name) VALUES (?, ?, ?, ?, ?)",
        )
        .run(object.id, object.tier, object.sizeBytes, object.sha256, object.fileName);
      this.db.prepare("DELETE FROM reservations WHERE id = ?").run(reservationId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Finalize a successful migration: move the object row to the new
   * tier/file and drop the reservation in one transaction. The caller
   * deletes the old source file afterwards; source capacity is released
   * here only because the object row now accounts for the target tier.
   */
  finalizeMigration(
    reservationId: string,
    objectId: string,
    newTier: Tier,
    newFileName: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE objects SET tier = ?, file_name = ? WHERE id = ?")
        .run(newTier, newFileName, objectId);
      this.db.prepare("DELETE FROM reservations WHERE id = ?").run(reservationId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Recovery helper: finalize a migration whose source file is already
   * gone and whose target file is complete (crash between source delete
   * and commit). Same transaction as finalizeMigration.
   */
  completeMigrationAfterCrash(
    reservationId: string,
    objectId: string,
    newTier: Tier,
    newFileName: string,
  ): void {
    this.finalizeMigration(reservationId, objectId, newTier, newFileName);
  }
}
