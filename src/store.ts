import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { MetadataDb } from "./db";
import {
  ObjectNotFoundError,
  TIERS,
} from "./types";
import type { ObjectInfo, StoreOptions, Tier, TierUsage } from "./types";

const FINAL_SUFFIX = ".bin";
const TMP_SUFFIX = ".part";

function finalName(id: string): string {
  return id + FINAL_SUFFIX;
}

function tmpName(id: string): string {
  return id + TMP_SUFFIX;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await fsp.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Tiered archive store. Objects live as files in per-tier directories;
 * ownership, checksums and capacity accounting persist in SQLite.
 *
 * Lifecycle policy and migration eligibility are decided by the caller;
 * this class only performs stores and authorized migrations.
 */
export class ArchiveStore {
  private readonly options: StoreOptions;
  private readonly db: MetadataDb;
  private readonly capacities: Record<Tier, number>;
  /** Serializes migrations per object id. */
  private readonly locks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: StoreOptions) {
    this.options = options;
    this.capacities = {
      hot: options.tiers.hot.capacityBytes,
      warm: options.tiers.warm.capacityBytes,
      cold: options.tiers.cold.capacityBytes,
    };
    for (const tier of TIERS) {
      fs.mkdirSync(options.tiers[tier].dir, { recursive: true });
    }
    this.db = new MetadataDb(options.dbPath);
    this.checkCapacities();
    this.recoverSync();
  }

  /**
   * Re-open an existing store. Orphaned temp files from interrupted
   * operations are removed and their reservations released.
   */
  static open(options: StoreOptions): ArchiveStore {
    return new ArchiveStore(options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("store is closed");
  }

  private tierDir(tier: Tier): string {
    return this.options.tiers[tier].dir;
  }

  /** Persist capacities on first use; enforce them on reopen. */
  private checkCapacities(): void {
    for (const tier of TIERS) {
      const key = `capacity.${tier}`;
      const stored = this.db.getMeta(key);
      if (stored === null) {
        this.db.setMeta(key, String(this.capacities[tier]));
      } else if (Number(stored) !== this.capacities[tier]) {
        throw new Error(
          `tier ${tier} capacity mismatch: store was initialized with ${stored}, ` +
            `got ${this.capacities[tier]}`,
        );
      }
    }
  }

  /**
   * Store a new object into the given tier. `sizeBytes` is the trusted
   * total length declared by the caller; capacity for the full length is
   * reserved before the first byte is accepted. The object becomes
   * readable only after the stream completes, the byte count matches and
   * the file is fully on disk.
   *
   * @returns the new object id.
   */
  async put(
    tier: Tier,
    content: AsyncIterable<Uint8Array> | Readable,
    sizeBytes: number,
  ): Promise<string> {
    this.assertOpen();
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error(`invalid sizeBytes: ${sizeBytes}`);
    }
    const id = randomUUID();
    const dir = this.tierDir(tier);
    const tmpPath = path.join(dir, tmpName(id));
    const finalPath = path.join(dir, finalName(id));
    // Reserve the full declared length before accepting a single byte.
    this.db.createReservation({
      id,
      tier,
      sizeBytes,
      kind: "put",
      objectId: null,
      tmpName: tmpName(id),
      capacityBytes: this.capacities[tier],
    });
    try {
      const hash = createHash("sha256");
      let received = 0;
      const handle = await fsp.open(tmpPath, "wx");
      try {
        for await (const chunk of content as AsyncIterable<Uint8Array>) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buf.length;
          if (received > sizeBytes) {
            throw new Error(
              `stream delivered more bytes than declared: ${received} > ${sizeBytes}`,
            );
          }
          hash.update(buf);
          let offset = 0;
          while (offset < buf.length) {
            const { bytesWritten } = await handle.write(
              buf,
              offset,
              buf.length - offset,
            );
            offset += bytesWritten;
          }
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (received !== sizeBytes) {
        throw new Error(
          `stream length mismatch: declared ${sizeBytes}, received ${received}`,
        );
      }
      // Move the content into place first; the metadata commit below is
      // what publishes the object. If we crash between the two, the
      // leftover reservation makes recovery drop the unreferenced file.
      await fsp.rename(tmpPath, finalPath);
      await fsyncDir(dir);
      this.db.finalizePut(id, {
        id,
        tier,
        sizeBytes,
        sha256: hash.digest("hex"),
        fileName: finalName(id),
      });
      return id;
    } catch (err) {
      // Temp content is removed before the capacity hold is released.
      await removeIfExists(tmpPath);
      await removeIfExists(finalPath);
      this.db.deleteReservation(id);
      throw err;
    }
  }

  /**
   * Migrate an object to another tier. The source copy keeps full
   * capacity and stays readable until the target copy is complete; the
   * target tier reserves the full size for the duration. On failure the
   * target temp file is removed before the reservation is released.
   */
  async migrate(id: string, target: Tier): Promise<void> {
    this.assertOpen();
    const previous = this.locks.get(id);
    // Start synchronously when uncontended so the capacity reservation is
    // visible to callers before this function's first await.
    const run = previous
      ? previous.then(() => this.migrateInternal(id, target))
      : this.migrateInternal(id, target);
    const tracked = run.catch(() => undefined);
    this.locks.set(id, tracked);
    try {
      await run;
    } finally {
      if (this.locks.get(id) === tracked) this.locks.delete(id);
    }
  }

  private async migrateInternal(id: string, target: Tier): Promise<void> {
    const obj = this.db.getObject(id);
    if (!obj) throw new ObjectNotFoundError(id);
    if (obj.tier === target) return;

    const sourceDir = this.tierDir(obj.tier);
    const targetDir = this.tierDir(target);
    const sourcePath = path.join(sourceDir, obj.fileName);
    const reservationId = randomUUID();
    const tmp = tmpName(id);
    const tmpPath = path.join(targetDir, tmp);
    const finalPath = path.join(targetDir, finalName(id));

    // The source tier keeps billing the object (its row is untouched) and
    // the target tier now reserves the full object size.
    this.db.createReservation({
      id: reservationId,
      tier: target,
      sizeBytes: obj.sizeBytes,
      kind: "migration",
      objectId: id,
      tmpName: tmp,
      capacityBytes: this.capacities[target],
    });

    try {
      await pipeline(
        fs.createReadStream(sourcePath),
        fs.createWriteStream(tmpPath, { flags: "wx" }),
      );
      const handle = await fsp.open(tmpPath, "r");
      try {
        await handle.sync();
        const stat = await handle.stat();
        if (stat.size !== obj.sizeBytes) {
          throw new Error(
            `copied size mismatch: expected ${obj.sizeBytes}, got ${stat.size}`,
          );
        }
      } finally {
        await handle.close();
      }
      // Target copy complete: publish the file name in the target tier.
      await fsp.rename(tmpPath, finalPath);
      await fsyncDir(targetDir);
      // Only now may the source copy go away; source capacity is released
      // by the metadata commit below, after the copy is actually cleared.
      await fsp.unlink(sourcePath);
      await fsyncDir(sourceDir);
      // The target reservation converts to formal usage; no second charge.
      this.db.finalizeMigration(reservationId, id, target, finalName(id));
    } catch (err) {
      if (await pathExists(sourcePath)) {
        // Source intact: roll back every trace of the target copy first,
        // then release the target reservation.
        await removeIfExists(tmpPath);
        await removeIfExists(finalPath);
        this.db.deleteReservation(reservationId);
        throw err;
      }
      // Source already cleared: the only consistent finish is to commit
      // the migration if the target copy is complete.
      if (await pathExists(finalPath)) {
        this.db.finalizeMigration(reservationId, id, target, finalName(id));
        return;
      }
      await removeIfExists(tmpPath);
      this.db.deleteReservation(reservationId);
      throw err;
    }
  }

  /** Read back the full object content. */
  async read(id: string): Promise<Buffer> {
    this.assertOpen();
    // Retry: a concurrent migration may flip the tier between the metadata
    // lookup and the file open.
    for (let attempt = 0; attempt < 3; attempt++) {
      const obj = this.db.getObject(id);
      if (!obj) throw new ObjectNotFoundError(id);
      try {
        return await fsp.readFile(path.join(this.tierDir(obj.tier), obj.fileName));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    throw new ObjectNotFoundError(id);
  }

  /** Stream the object content. */
  async createReadStream(id: string): Promise<Readable> {
    this.assertOpen();
    for (let attempt = 0; attempt < 3; attempt++) {
      const obj = this.db.getObject(id);
      if (!obj) throw new ObjectNotFoundError(id);
      try {
        // Open the fd first: an unlink during a concurrent migration does
        // not affect an already-open descriptor.
        const handle = await fsp.open(
          path.join(this.tierDir(obj.tier), obj.fileName),
          "r",
        );
        return fs.createReadStream("", {
          fd: handle.fd,
          autoClose: true,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    throw new ObjectNotFoundError(id);
  }

  /** Locate an object: tier, size and checksum. */
  stat(id: string): ObjectInfo {
    this.assertOpen();
    const obj = this.db.getObject(id);
    if (!obj) throw new ObjectNotFoundError(id);
    return { id: obj.id, tier: obj.tier, sizeBytes: obj.sizeBytes, sha256: obj.sha256 };
  }

  /** Capacity snapshot for every tier. */
  usage(): Record<Tier, TierUsage> {
    this.assertOpen();
    const result = {} as Record<Tier, TierUsage>;
    for (const tier of TIERS) {
      const used = this.db.usedBytes(tier);
      const reserved = this.db.reservedBytes(tier);
      result[tier] = {
        capacityBytes: this.capacities[tier],
        usedBytes: used,
        reservedBytes: reserved,
        availableBytes: this.capacities[tier] - used - reserved,
      };
    }
    return result;
  }

  /**
   * Crash recovery, run synchronously at open:
   * 1. Resolve every leftover reservation (put or migration).
   * 2. Complete puts that committed metadata but not the rename.
   * 3. Sweep unreferenced files from the tier directories.
   */
  private recoverSync(): void {
    for (const r of this.db.listReservations()) {
      const dir = this.tierDir(r.tier);
      if (r.kind === "put") {
        // A put reservation means the metadata commit never happened.
        removeSync(path.join(dir, r.tmpName));
        this.db.deleteReservation(r.id);
      } else if (r.kind === "migration" && r.objectId) {
        const obj = this.db.getObject(r.objectId);
        if (!obj) {
          removeSync(path.join(dir, r.tmpName));
          this.db.deleteReservation(r.id);
          continue;
        }
        const sourcePath = path.join(this.tierDir(obj.tier), obj.fileName);
        const targetFinal = path.join(dir, finalName(obj.id));
        const targetTmp = path.join(dir, r.tmpName);
        if (!fs.existsSync(sourcePath) && fs.existsSync(targetFinal)) {
          // Crashed after the source copy was cleared but before the
          // commit: the target copy is the only one left, finish the move.
          removeSync(targetTmp);
          this.db.completeMigrationAfterCrash(
            r.id,
            obj.id,
            r.tier,
            finalName(obj.id),
          );
        } else {
          // Source copy still there: the migration never committed.
          removeSync(targetTmp);
          removeSync(targetFinal);
          this.db.deleteReservation(r.id);
        }
      } else {
        removeSync(path.join(dir, r.tmpName));
        this.db.deleteReservation(r.id);
      }
    }

    for (const obj of this.db.listObjects()) {
      const dir = this.tierDir(obj.tier);
      const finalPath = path.join(dir, obj.fileName);
      if (fs.existsSync(finalPath)) continue;
      const tmpPath = path.join(dir, tmpName(obj.id));
      if (fs.existsSync(tmpPath)) {
        // Put committed its metadata but crashed before the rename.
        fs.renameSync(tmpPath, finalPath);
      }
    }

    // Sweep files no metadata refers to.
    const referenced = new Map<Tier, Set<string>>();
    for (const tier of TIERS) referenced.set(tier, new Set<string>());
    for (const obj of this.db.listObjects()) {
      referenced.get(obj.tier)!.add(obj.fileName);
    }
    for (const r of this.db.listReservations()) {
      referenced.get(r.tier)!.add(r.tmpName);
    }
    for (const tier of TIERS) {
      const dir = this.tierDir(tier);
      for (const entry of fs.readdirSync(dir)) {
        if (entry === "." || entry === "..") continue;
        if (entry.endsWith(FINAL_SUFFIX) || entry.endsWith(TMP_SUFFIX)) {
          if (!referenced.get(tier)!.has(entry)) {
            removeSync(path.join(dir, entry));
          }
        }
      }
    }
  }
}

function removeSync(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
