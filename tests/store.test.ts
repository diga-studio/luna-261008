import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CapacityExceededError,
  ObjectNotFoundError,
  TieredArchiveStore,
  TIERS,
} from '../src/index.ts';
import type { Tier, TierConfig } from '../src/index.ts';

type Caps = Record<Tier, number>;

const DEFAULT_CAPS: Caps = { hot: 100, warm: 100, cold: 100 };

function makeStore(t: Parameters<Parameters<typeof test>[1]>[0], caps: Caps = DEFAULT_CAPS) {
  const root = mkdtempSync(join(tmpdir(), 'tas-test-'));
  const store = new TieredArchiveStore({
    dbPath: join(root, 'meta.db'),
    tiers: TIERS.map((tier) => ({ tier, dir: join(root, tier), capacityBytes: caps[tier] })),
  });
  t.after(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { store, root };
}

async function* streamOf(buf: Buffer, chunkSize = buf.length || 1): AsyncIterable<Uint8Array> {
  for (let off = 0; off < buf.length; off += chunkSize) {
    yield buf.subarray(off, off + chunkSize);
  }
}

async function* brokenStream(chunks: Buffer[], error: Error): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
  throw error;
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    total += statSync(join(dir, entry)).size;
  }
  return total;
}

function randomBytes(n: number, seed: number): Buffer {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (seed + i * 31) & 0xff;
  return buf;
}

test('store fills a tier exactly to its capacity', async (t) => {
  const { store } = makeStore(t);
  const a = await store.store('hot', 60, streamOf(randomBytes(60, 1)));
  const b = await store.store('hot', 40, streamOf(randomBytes(40, 2)));
  assert.ok(a && b);
  assert.deepEqual(store.capacity().hot, { capacityBytes: 100, usedBytes: 100, availableBytes: 0 });
});

test('store rejects one byte over capacity and leaves no trace', async (t) => {
  const { store, root } = makeStore(t);
  await store.store('hot', 100, streamOf(randomBytes(100, 3)));
  await assert.rejects(store.store('hot', 1, streamOf(randomBytes(1, 4))), CapacityExceededError);
  assert.equal(store.capacity().hot.usedBytes, 100);
  assert.equal(readdirSync(join(root, 'hot')).length, 1);
});

test('store rejects when remaining space is one byte short', async (t) => {
  const { store } = makeStore(t);
  await store.store('hot', 60, streamOf(randomBytes(60, 5)));
  await assert.rejects(store.store('hot', 41, streamOf(randomBytes(41, 6))), CapacityExceededError);
  assert.equal(store.capacity().hot.usedBytes, 60);
  await store.store('hot', 40, streamOf(randomBytes(40, 7)));
  assert.equal(store.capacity().hot.usedBytes, 100);
});

test('capacity is reserved at full declared length while the stream is still arriving', async (t) => {
  const { store } = makeStore(t);
  const pending = store.store('hot', 80, streamOf(randomBytes(80, 8), 8));
  // The reservation is taken synchronously before the first byte lands.
  assert.equal(store.capacity().hot.usedBytes, 80);
  await assert.rejects(store.store('hot', 21, streamOf(randomBytes(21, 9))), CapacityExceededError);
  const id = await pending;
  assert.equal(store.locate(id).sizeBytes, 80);
});

test('interrupted stream publishes nothing and the space stays usable', async (t) => {
  const { store, root } = makeStore(t);
  await assert.rejects(
    store.store('hot', 50, brokenStream([randomBytes(30, 10)], new Error('boom'))),
    /boom/,
  );
  assert.equal(store.capacity().hot.usedBytes, 0);
  assert.equal(readdirSync(join(root, 'hot')).length, 0);
  const id = await store.store('hot', 50, streamOf(randomBytes(50, 11)));
  assert.ok((await store.read(id)).equals(randomBytes(50, 11)));
});

test('stream ending early publishes nothing and the space stays usable', async (t) => {
  const { store, root } = makeStore(t);
  await assert.rejects(store.store('hot', 50, streamOf(randomBytes(30, 12))), /length mismatch/);
  assert.equal(store.capacity().hot.usedBytes, 0);
  assert.equal(readdirSync(join(root, 'hot')).length, 0);
  await store.store('hot', 100, streamOf(randomBytes(100, 13)));
  assert.equal(store.capacity().hot.usedBytes, 100);
});

test('migrate fills the target tier exactly', async (t) => {
  const { store } = makeStore(t, { hot: 100, warm: 60, cold: 100 });
  const data = randomBytes(60, 14);
  const id = await store.store('hot', 60, streamOf(data));
  await store.migrate(id, 'warm');
  assert.equal(store.locate(id).tier, 'warm');
  assert.deepEqual(store.capacity().warm, { capacityBytes: 60, usedBytes: 60, availableBytes: 0 });
  assert.equal(store.capacity().hot.usedBytes, 0);
  assert.ok((await store.read(id)).equals(data));
});

test('migrate rejects one byte over target capacity without side effects', async (t) => {
  const { store, root } = makeStore(t, { hot: 100, warm: 59, cold: 100 });
  const data = randomBytes(60, 15);
  const id = await store.store('hot', 60, streamOf(data));
  await assert.rejects(store.migrate(id, 'warm'), CapacityExceededError);
  assert.equal(store.locate(id).tier, 'hot');
  assert.equal(store.capacity().warm.usedBytes, 0);
  assert.equal(store.capacity().hot.usedBytes, 60);
  assert.equal(readdirSync(join(root, 'warm')).length, 0);
  assert.ok((await store.read(id)).equals(data));
});

test('during migration both tiers bill the full object exactly once each', async (t) => {
  const { store } = makeStore(t);
  const id = await store.store('hot', 60, streamOf(randomBytes(60, 16)));
  const pending = store.migrate(id, 'warm');
  // The target reservation is taken synchronously; the source is still billed.
  assert.equal(store.capacity().hot.usedBytes, 60);
  assert.equal(store.capacity().warm.usedBytes, 60);
  await assert.rejects(store.store('warm', 41, streamOf(randomBytes(41, 17))), CapacityExceededError);
  await pending;
  assert.equal(store.capacity().hot.usedBytes, 0);
  assert.equal(store.capacity().warm.usedBytes, 60);
});

test('object stays readable while a migration is in flight', async (t) => {
  const { store } = makeStore(t, { hot: 8 * 1024 * 1024, warm: 8 * 1024 * 1024, cold: 100 });
  const data = randomBytes(4 * 1024 * 1024, 18);
  const id = await store.store('hot', data.length, streamOf(data, 64 * 1024));
  const pending = store.migrate(id, 'warm');
  const during = await store.read(id);
  assert.ok(during.equals(data));
  await pending;
  assert.ok((await store.read(id)).equals(data));
});

test('failed copy cleans up and the object remains in the source tier', async (t) => {
  const { store, root } = makeStore(t);
  const data = randomBytes(50, 19);
  const id = await store.store('hot', 50, streamOf(data));
  const coldDir = join(root, 'cold');
  chmodSync(coldDir, 0o555);
  try {
    await assert.rejects(store.migrate(id, 'cold'));
  } finally {
    chmodSync(coldDir, 0o755);
  }
  assert.equal(store.locate(id).tier, 'hot');
  assert.equal(store.capacity().cold.usedBytes, 0);
  assert.equal(store.capacity().hot.usedBytes, 50);
  assert.equal(readdirSync(coldDir).length, 0);
  assert.ok((await store.read(id)).equals(data));
  await store.migrate(id, 'cold');
  assert.equal(store.locate(id).tier, 'cold');
  assert.ok((await store.read(id)).equals(data));
});

test('results survive a close and reopen', async (t) => {
  const { store, root } = makeStore(t);
  const a = randomBytes(30, 20);
  const b = randomBytes(40, 21);
  const idA = await store.store('hot', 30, streamOf(a));
  const idB = await store.store('hot', 40, streamOf(b));
  await store.migrate(idB, 'cold');
  store.close();

  const reopened = new TieredArchiveStore({
    dbPath: join(root, 'meta.db'),
    tiers: TIERS.map((tier) => ({ tier, dir: join(root, tier), capacityBytes: 100 })),
  });
  assert.equal(reopened.locate(idA).tier, 'hot');
  assert.equal(reopened.locate(idB).tier, 'cold');
  assert.ok((await reopened.read(idA)).equals(a));
  assert.ok((await reopened.read(idB)).equals(b));
  assert.equal(reopened.capacity().hot.usedBytes, 30);
  assert.equal(reopened.capacity().cold.usedBytes, 40);
  reopened.close();
});

test('unknown objects are reported', async (t) => {
  const { store } = makeStore(t);
  assert.throws(() => store.locate('nope'), ObjectNotFoundError);
  await assert.rejects(store.read('nope'), ObjectNotFoundError);
  await assert.rejects(store.migrate('nope', 'warm'), ObjectNotFoundError);
});

test('end-to-end: every stored object reads back and disk usage matches the ledger', async (t) => {
  const { store, root } = makeStore(t, { hot: 400, warm: 400, cold: 400 });
  const kept = new Map<string, Buffer>();
  const save = async (tier: Tier, size: number, seed: number) => {
    const data = randomBytes(size, seed);
    const id = await store.store(tier, size, streamOf(data, 16));
    kept.set(id, data);
    return id;
  };
  const a = await save('hot', 120, 30);
  const b = await save('hot', 100, 31);
  const c = await save('warm', 90, 32);
  const d = await save('cold', 70, 33);
  await store.migrate(a, 'warm');
  await store.migrate(b, 'cold');
  await store.migrate(c, 'cold');
  await store.migrate(d, 'warm');
  await store.migrate(a, 'cold');

  for (const [id, data] of kept) {
    const back = await store.read(id);
    assert.ok(back.equals(data), `object ${id} must read back byte-identical`);
    assert.equal(
      store.locate(id).sha256,
      (await import('node:crypto')).createHash('sha256').update(back).digest('hex'),
    );
  }
  const caps = store.capacity();
  for (const tier of TIERS) {
    assert.equal(
      dirBytes(join(root, tier)),
      caps[tier].usedBytes,
      `tier ${tier}: bytes on disk must match the ledger`,
    );
  }
  store.close();

  const reopened = new TieredArchiveStore({
    dbPath: join(root, 'meta.db'),
    tiers: TIERS.map((tier) => ({ tier, dir: join(root, tier), capacityBytes: 400 })),
  });
  for (const [id, data] of kept) {
    assert.ok((await reopened.read(id)).equals(data));
  }
  const capsAfter = reopened.capacity();
  for (const tier of TIERS) {
    assert.equal(dirBytes(join(root, tier)), capsAfter[tier].usedBytes);
  }
  reopened.close();
});

test('leftover reservations and temp files from a crash are reclaimed on open', async (t) => {
  const { store, root } = makeStore(t);
  const id = await store.store('hot', 40, streamOf(randomBytes(40, 40)));
  store.close();

  const { writeFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, 'meta.db'));
  const tempPath = join(root, 'warm', '.tmp-crashed');
  writeFileSync(tempPath, randomBytes(25, 41));
  db.prepare(
    'INSERT INTO reservations (id, kind, tier, size_bytes, object_id, temp_path, final_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('r1', 'migrate-target', 'warm', 40, id, tempPath, join(root, 'warm', `${id}.bin`));
  db.close();

  const reopened = new TieredArchiveStore({
    dbPath: join(root, 'meta.db'),
    tiers: TIERS.map((tier) => ({ tier, dir: join(root, tier), capacityBytes: 100 })),
  });
  assert.equal(reopened.capacity().warm.usedBytes, 0);
  assert.equal(reopened.capacity().hot.usedBytes, 40);
  assert.equal(readdirSync(join(root, 'warm')).length, 0);
  assert.equal(reopened.locate(id).tier, 'hot');
  assert.ok((await reopened.read(id)).equals(randomBytes(40, 40)));
  reopened.close();
});
