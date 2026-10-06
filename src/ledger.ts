import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ArchiveStore } from "./archiveStore.js";
import { OnlineStore } from "./onlineStore.js";
import type { AuditRecord, CrashPoint, LedgerOptions, Page } from "./types.js";

/**
 * Compliance audit ledger. Online records live in SQLite; records older
 * than a caller-supplied retention cutoff are moved into gzip archive files.
 * Single-process, serial use only.
 *
 * Crash safety of archive():
 *   1. records are written to `<name>.tmp`, fsynced, renamed to `<name>`,
 *      and the directory is fsynced;
 *   2. only then does one SQLite transaction register the archive in the
 *      manifest and delete the records from the online table.
 * A crash before the commit leaves an orphan file whose records are still
 * online; open() deletes such orphans (and stale temp files), so a retry
 * with the same cutoff migrates them again. A crash after the commit is a
 * completed archive. Either way the ledger stays whole with no duplicates.
 */
export class AuditLedger {
  private readonly online: OnlineStore;
  private readonly archives: ArchiveStore;
  private readonly crashHook?: ((point: CrashPoint) => void) | undefined;
  private mergedCache: AuditRecord[] | null = null;

  private constructor(
    online: OnlineStore,
    archives: ArchiveStore,
    crashHook?: (point: CrashPoint) => void,
  ) {
    this.online = online;
    this.archives = archives;
    this.crashHook = crashHook;
  }

  /** Open (and recover) a ledger rooted at `dir`. */
  static open(options: LedgerOptions): AuditLedger {
    mkdirSync(options.dir, { recursive: true });
    const online = new OnlineStore(join(options.dir, "online.db"));
    const archives = new ArchiveStore(join(options.dir, "archives"));
    archives.recover(online.listArchives());
    return new AuditLedger(online, archives, options.crashHook);
  }

  /** Append an immutable record; returns its strictly-increasing id. */
  append(eventTimeMs: number, body: string): number {
    const id = this.online.append(eventTimeMs, body);
    this.mergedCache = null;
    return id;
  }

  /**
   * Move all records with eventTimeMs strictly before `cutoffMs` that exist
   * at call time into a new gzip archive, removing their bodies from SQLite.
   * Returns the number of archived records.
   */
  archive(cutoffMs: number): number {
    const records = this.online.selectOlderThan(cutoffMs);
    if (records.length === 0) {
      return 0;
    }
    records.sort((a, b) => a.id - b.id);

    const seq = this.online.listArchives().length + 1;
    const fileName = `archive-${String(seq).padStart(6, "0")}.jsonl.gz`;

    this.archives.writeArchive(fileName, records, this.crashHook);
    this.crashHook?.("beforeManifestCommit");
    this.online.commitArchive(
      fileName,
      records.map((record) => record.id),
    );
    this.crashHook?.("afterManifestCommit");

    this.mergedCache = null;
    return records.length;
  }

  /**
   * Read the whole ledger (online + archived) in ascending id order.
   * `offset` is a record index from the start of the merged ledger;
   * pass `page.nextOffset` to continue. No other operations may run
   * between consecutive page reads.
   */
  readPage(offset: number, limit: number): Page {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError("offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("limit must be a positive integer");
    }
    const merged = this.merged();
    const records = merged.slice(offset, offset + limit);
    const nextOffset = offset + limit < merged.length ? offset + limit : null;
    return { records, nextOffset };
  }

  /** Total number of records (online + archived). */
  size(): number {
    return this.merged().length;
  }

  /** Test helper: ids whose bodies are still present in SQLite. */
  onlineIds(): number[] {
    return this.online
      .all()
      .map((record) => record.id)
      .sort((a, b) => a - b);
  }

  close(): void {
    this.online.close();
  }

  private merged(): AuditRecord[] {
    if (this.mergedCache !== null) {
      return this.mergedCache;
    }
    const all: AuditRecord[] = [];
    for (const fileName of this.online.listArchives()) {
      all.push(...this.archives.readArchive(fileName));
    }
    all.push(...this.online.all());
    all.sort((a, b) => a.id - b.id);
    this.mergedCache = all;
    return all;
  }
}
