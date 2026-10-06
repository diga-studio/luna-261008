import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./database.ts";
import { readSegment, segmentFileName, writeSegment } from "./segment.ts";
import type { ArchiveHooks, ArchiveResult, AuditRecord, OpenOptions, Page } from "./types.ts";

const SEGMENTS_DIR = "segments";
const TMP_SUFFIX = ".tmp";
const SEALED_SUFFIX = ".jsonl.gz";

/**
 * Main entry point. Single-process, serial use only.
 *
 * Layout inside `dir`:
 *   ledger.sqlite            online records + id counter + segment manifest
 *   segments/NNNNNN.jsonl.gz committed archive segments
 *   segments/*.tmp           incomplete writes, removed on recovery
 *
 * Crash protocol for archive():
 *   1. write segment to *.tmp, fsync, rename to final name (atomic seal)
 *   2. one SQLite transaction publishes the segment in the manifest and
 *      deletes the archived bodies from the online table
 * A crash leaves either a *.tmp file or a sealed-but-unmanifested file;
 * both are deleted on recovery because their records are still online.
 * After the commit, the segment file is the only home of those bodies.
 */
export class AuditArchive {
  private readonly db: Database;
  private readonly segmentsDir: string;
  private readonly hooks: ArchiveHooks;

  private constructor(db: Database, segmentsDir: string, hooks: ArchiveHooks) {
    this.db = db;
    this.segmentsDir = segmentsDir;
    this.hooks = hooks;
  }

  static open(options: OpenOptions): AuditArchive {
    mkdirSync(options.dir, { recursive: true });
    const segmentsDir = join(options.dir, SEGMENTS_DIR);
    mkdirSync(segmentsDir, { recursive: true });
    const db = new Database(join(options.dir, "ledger.sqlite"));
    const archive = new AuditArchive(db, segmentsDir, options.hooks ?? {});
    archive.recover();
    return archive;
  }

  /**
   * Remove leftovers of interrupted archive runs and verify that every
   * committed segment is present, so the first operation after open faces
   * a complete ledger.
   */
  private recover(): void {
    const manifest = new Set(this.db.listSegments());
    for (const name of readdirSync(this.segmentsDir)) {
      if (name.endsWith(TMP_SUFFIX)) {
        rmSync(join(this.segmentsDir, name));
      } else if (name.endsWith(SEALED_SUFFIX) && !manifest.has(name)) {
        // Sealed but never committed: its records are still online, so the
        // file is a would-be permanent duplicate. Remove it.
        rmSync(join(this.segmentsDir, name));
      }
    }
    for (const file of manifest) {
      if (!existsSync(join(this.segmentsDir, file))) {
        throw new Error(`committed archive segment is missing: ${file}`);
      }
    }
  }

  /** Append a record; returns the assigned id. Durable once returned. */
  append(eventTimeMs: number, body: unknown): number {
    if (!Number.isFinite(eventTimeMs)) {
      throw new TypeError("eventTimeMs must be a finite number (milliseconds UTC)");
    }
    return this.db.append(eventTimeMs, JSON.stringify(body));
  }

  /**
   * Move all records with eventTimeMs strictly before cutoffMs into a new
   * gzip segment and delete their bodies from SQLite. Records appended
   * after this call starts are left for the next pass.
   */
  archive(cutoffMs: number): ArchiveResult {
    const rows = this.db.selectArchivable(cutoffMs);
    if (rows.length === 0) {
      return { archivedCount: 0, segmentFile: null };
    }
    const records: AuditRecord[] = rows.map((r) => ({
      id: r.id,
      eventTimeMs: r.eventTimeMs,
      body: JSON.parse(r.bodyJson) as unknown,
    }));
    const file = segmentFileName(this.db.nextSegmentSeq());
    const tmpPath = join(this.segmentsDir, file + TMP_SUFFIX);
    const finalPath = join(this.segmentsDir, file);
    writeSegment(tmpPath, finalPath, records);
    this.hooks.afterSegmentSealed?.();
    try {
      this.db.commitSegment(file, records.map((r) => r.id));
    } catch (err) {
      // Keep the invariant "sealed file exists iff in manifest".
      rmSync(finalPath, { force: true });
      throw err;
    }
    this.hooks.afterCommit?.();
    return { archivedCount: records.length, segmentFile: file };
  }

  /**
   * Read up to `limit` records with id > cursor (0 for the first page),
   * ascending by id, spanning archived and online records. Each record
   * appears exactly once across the whole ledger.
   */
  readPage(cursor: number, limit: number): Page {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("limit must be a positive integer");
    }
    const all: AuditRecord[] = [];
    for (const file of this.db.listSegments()) {
      all.push(...readSegment(join(this.segmentsDir, file)));
    }
    for (const row of this.db.selectAllOnline()) {
      all.push({ id: row.id, eventTimeMs: row.eventTimeMs, body: JSON.parse(row.bodyJson) as unknown });
    }
    all.sort((a, b) => a.id - b.id);
    const page = all.filter((r) => r.id > cursor).slice(0, limit);
    const last = page[page.length - 1];
    const hasMore = last !== undefined && all.some((r) => r.id > last.id);
    return { records: page, nextCursor: hasMore ? last.id : null };
  }

  close(): void {
    this.db.close();
  }
}
