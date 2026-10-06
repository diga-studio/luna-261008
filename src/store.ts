import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { openDatabase } from './db.ts';
import { TIERS } from './types.ts';
import type { ObjectInfo, StoreConfig, Tier, TierCapacity } from './types.ts';

export class CapacityExceededError extends Error {
  override readonly name = 'CapacityExceededError';
}

export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
}

const FINAL_SUFFIX = '.bin';

interface ObjectRow {
  id: string;
  tier: string;
  size_bytes: number;
  sha256: string;
}

interface ReservationRow {
  id: string;
  kind: string;
  tier: string;
  size_bytes: number;
  object_id: string | null;
  temp_path: string | null;
  final_path: string | null;
}

export class TieredArchiveStore {
  readonly #db: ReturnType<typeof openDatabase>;
  readonly #dirs: Record<Tier, string>;
  readonly #caps: Record<Tier, number>;

  constructor(config: StoreConfig) {
    const dirs = {} as Record<Tier, string>;
    const caps = {} as Record<Tier, number>;
    for (const t of config.tiers) {
      if (!TIERS.includes(t.tier)) throw new Error(`unknown tier: ${t.tier}`);
      if (dirs[t.tier] !== undefined) throw new Error(`duplicate tier config: ${t.tier}`);
      if (!Number.isSafeInteger(t.capacityBytes) || t.capacityBytes < 0) {
        throw new RangeError(`invalid capacity for tier ${t.tier}: ${t.capacityBytes}`);
      }
      dirs[t.tier] = t.dir;
      caps[t.tier] = t.capacityBytes;
    }
    for (const tier of TIERS) {
      if (dirs[tier] === undefined) throw new Error(`missing tier config: ${tier}`);
    }
    this.#dirs = dirs;
    this.#caps = caps;
    for (const tier of TIERS) fs.mkdirSync(dirs[tier], { recursive: true });
    this.#db = openDatabase(config.dbPath);
    const getMeta = this.#db.prepare('SELECT value FROM meta WHERE key = ?');
    const setMeta = this.#db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const tier of TIERS) {
      const key = `capacity:${tier}`;
      const row = getMeta.get(key) as { value: string } | undefined;
      if (row === undefined) {
        setMeta.run(key, String(caps[tier]));
      } else if (Number(row.value) !== caps[tier]) {
        throw new Error(`capacity for tier ${tier} is immutable: stored ${row.value}, got ${caps[tier]}`);
      }
    }
    this.#recover();
  }

  async store(tier: Tier, lengthBytes: number, data: AsyncIterable<Uint8Array>): Promise<string> {
    this.#assertTier(tier);
    if (!Number.isSafeInteger(lengthBytes) || lengthBytes < 0) {
      throw new RangeError(`invalid length: ${lengthBytes}`);
    }
    const id = randomUUID();
    const tempPath = path.join(this.#dirs[tier], `.tmp-${randomUUID()}`);
    const finalPath = path.join(this.#dirs[tier], id + FINAL_SUFFIX);
    if (this.#usedBytes(tier) + lengthBytes > this.#caps[tier]) {
      throw new CapacityExceededError(
        `tier ${tier} cannot fit ${lengthBytes} bytes (${this.#usedBytes(tier)}/${this.#caps[tier]} used)`,
      );
    }
    const resId = randomUUID();
    this.#db
      .prepare('INSERT INTO reservations (id, kind, tier, size_bytes, object_id, temp_path, final_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(resId, 'store', tier, lengthBytes, id, tempPath, finalPath);
    const hash = createHash('sha256');
    let written = 0;
    try {
      const fh = await fsp.open(tempPath, 'w');
      try {
        for await (const chunk of data) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          await fh.write(buf);
          hash.update(buf);
          written += buf.length;
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (written !== lengthBytes) {
        throw new Error(`stream length mismatch: declared ${lengthBytes} bytes, received ${written}`);
      }
      await fsp.rename(tempPath, finalPath);
    } catch (err) {
      await fsp.rm(tempPath, { force: true });
      await fsp.rm(finalPath, { force: true });
      this.#db.prepare('DELETE FROM reservations WHERE id = ?').run(resId);
      throw err;
    }
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare('INSERT INTO objects (id, tier, size_bytes, sha256) VALUES (?, ?, ?, ?)')
        .run(id, tier, lengthBytes, hash.digest('hex'));
      this.#db.prepare('DELETE FROM reservations WHERE id = ?').run(resId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return id;
  }

  async migrate(id: string, target: Tier): Promise<void> {
    this.#assertTier(target);
    const obj = this.#getObject(id);
    const source = obj.tier as Tier;
    if (source === target) throw new Error(`object ${id} is already in tier ${target}`);
    const size = obj.size_bytes;
    const sourcePath = path.join(this.#dirs[source], id + FINAL_SUFFIX);
    const tempPath = path.join(this.#dirs[target], `.tmp-${randomUUID()}`);
    const finalPath = path.join(this.#dirs[target], id + FINAL_SUFFIX);
    if (this.#usedBytes(target) + size > this.#caps[target]) {
      throw new CapacityExceededError(
        `tier ${target} cannot fit ${size} bytes (${this.#usedBytes(target)}/${this.#caps[target]} used)`,
      );
    }
    const resId = randomUUID();
    this.#db
      .prepare('INSERT INTO reservations (id, kind, tier, size_bytes, object_id, temp_path, final_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(resId, 'migrate-target', target, size, id, tempPath, finalPath);
    const hash = createHash('sha256');
    try {
      const fh = await fsp.open(tempPath, 'w');
      try {
        const src = await fsp.open(sourcePath, 'r');
        try {
          const buf = Buffer.alloc(1024 * 1024);
          for (;;) {
            const { bytesRead } = await src.read(buf, 0, buf.length, null);
            if (bytesRead === 0) break;
            const chunk = buf.subarray(0, bytesRead);
            await fh.write(chunk);
            hash.update(chunk);
          }
        } finally {
          await src.close();
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (hash.digest('hex') !== obj.sha256) {
        throw new Error(`copy verification failed for object ${id}`);
      }
      await fsp.rename(tempPath, finalPath);
    } catch (err) {
      await fsp.rm(tempPath, { force: true });
      await fsp.rm(finalPath, { force: true });
      this.#db.prepare('DELETE FROM reservations WHERE id = ?').run(resId);
      throw err;
    }
    const srcResId = randomUUID();
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('UPDATE objects SET tier = ? WHERE id = ?').run(target, id);
      this.#db.prepare('DELETE FROM reservations WHERE id = ?').run(resId);
      this.#db
        .prepare('INSERT INTO reservations (id, kind, tier, size_bytes, object_id, temp_path, final_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(srcResId, 'migrate-source', source, size, id, sourcePath, null);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    await fsp.rm(sourcePath, { force: true });
    this.#db.prepare('DELETE FROM reservations WHERE id = ?').run(srcResId);
  }

  async read(id: string): Promise<Buffer> {
    const obj = this.#getObject(id);
    return fsp.readFile(path.join(this.#dirs[obj.tier as Tier], id + FINAL_SUFFIX));
  }

  locate(id: string): ObjectInfo {
    const obj = this.#getObject(id);
    return { id: obj.id, tier: obj.tier as Tier, sizeBytes: obj.size_bytes, sha256: obj.sha256 };
  }

  capacity(): Record<Tier, TierCapacity> {
    const result = {} as Record<Tier, TierCapacity>;
    for (const tier of TIERS) {
      const used = this.#usedBytes(tier);
      result[tier] = {
        capacityBytes: this.#caps[tier],
        usedBytes: used,
        availableBytes: this.#caps[tier] - used,
      };
    }
    return result;
  }

  close(): void {
    this.#db.close();
  }

  #assertTier(tier: Tier): void {
    if (!TIERS.includes(tier)) throw new Error(`unknown tier: ${tier}`);
  }

  #getObject(id: string): ObjectRow {
    const row = this.#db.prepare('SELECT * FROM objects WHERE id = ?').get(id) as ObjectRow | undefined;
    if (row === undefined) throw new ObjectNotFoundError(`object not found: ${id}`);
    return row;
  }

  #usedBytes(tier: Tier): number {
    const obj = this.#db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS s FROM objects WHERE tier = ?')
      .get(tier) as { s: number };
    const res = this.#db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS s FROM reservations WHERE tier = ?')
      .get(tier) as { s: number };
    return obj.s + res.s;
  }

  #recover(): void {
    const remove = (p: string | null): void => {
      if (p !== null) fs.rmSync(p, { force: true });
    };
    const rows = this.#db.prepare('SELECT * FROM reservations').all() as ReservationRow[];
    const del = this.#db.prepare('DELETE FROM reservations WHERE id = ?');
    for (const row of rows) {
      remove(row.temp_path);
      if (row.kind !== 'migrate-source') remove(row.final_path);
      del.run(row.id);
    }
    const listObjects = this.#db.prepare('SELECT id FROM objects WHERE tier = ?');
    for (const tier of TIERS) {
      const expected = new Set(
        (listObjects.all(tier) as { id: string }[]).map((o) => o.id + FINAL_SUFFIX),
      );
      for (const entry of fs.readdirSync(this.#dirs[tier])) {
        if (!expected.has(entry)) {
          fs.rmSync(path.join(this.#dirs[tier], entry), { force: true, recursive: true });
        }
      }
    }
  }
}
