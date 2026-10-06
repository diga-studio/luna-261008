import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  cleanup,
  contentOf,
  dirFiles,
  makeStore,
  streamOf,
} from "./helpers";
import { CapacityExceededError, ObjectNotFoundError } from "../src/index";

test("migration moves the object and releases the source tier", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  try {
    const content = contentOf(70, 1);
    const id = await ctx.store.put("hot", streamOf(content), content.length);

    await ctx.store.migrate(id, "cold");

    assert.equal(ctx.store.stat(id).tier, "cold");
    assert.deepEqual(await ctx.store.read(id), content);

    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 0);
    assert.equal(usage.hot.reservedBytes, 0);
    assert.equal(usage.cold.usedBytes, 70);
    assert.equal(usage.cold.reservedBytes, 0);

    // Only the target copy remains on disk.
    assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);
    assert.equal(dirFiles(ctx.options.tiers.cold.dir).length, 1);
  } finally {
    cleanup(ctx);
  }
});

test("migration across all tiers keeps content identical", async () => {
  const ctx = makeStore({ hot: 50, warm: 50, cold: 50 });
  try {
    const content = contentOf(50, 9);
    const id = await ctx.store.put("cold", streamOf(content), content.length);
    await ctx.store.migrate(id, "warm");
    assert.equal(ctx.store.stat(id).tier, "warm");
    await ctx.store.migrate(id, "hot");
    assert.equal(ctx.store.stat(id).tier, "hot");
    await ctx.store.migrate(id, "cold");
    assert.equal(ctx.store.stat(id).tier, "cold");
    assert.deepEqual(await ctx.store.read(id), content);
  } finally {
    cleanup(ctx);
  }
});

test("migration to the same tier is a no-op", async () => {
  const ctx = makeStore({ hot: 10, warm: 0, cold: 0 });
  try {
    const content = contentOf(10, 1);
    const id = await ctx.store.put("hot", streamOf(content), content.length);
    await ctx.store.migrate(id, "hot");
    assert.equal(ctx.store.stat(id).tier, "hot");
    assert.equal(ctx.store.usage().hot.usedBytes, 10);
    assert.equal(ctx.store.usage().hot.reservedBytes, 0);
  } finally {
    cleanup(ctx);
  }
});

test("migration may fill the target tier exactly", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 100 });
  try {
    const content = contentOf(100, 1);
    const id = await ctx.store.put("hot", streamOf(content), content.length);
    await ctx.store.migrate(id, "cold");
    assert.equal(ctx.store.usage().cold.usedBytes, 100);
    assert.equal(ctx.store.usage().cold.availableBytes, 0);
  } finally {
    cleanup(ctx);
  }
});

test("migration failing capacity by one byte changes nothing", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 99 });
  try {
    const content = contentOf(100, 1);
    const id = await ctx.store.put("hot", streamOf(content), content.length);

    await assert.rejects(ctx.store.migrate(id, "cold"), CapacityExceededError);

    // Ownership, readability and accounting are untouched.
    assert.equal(ctx.store.stat(id).tier, "hot");
    assert.deepEqual(await ctx.store.read(id), content);
    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 100);
    assert.equal(usage.cold.usedBytes, 0);
    assert.equal(usage.cold.reservedBytes, 0);
    assert.equal(dirFiles(ctx.options.tiers.cold.dir).length, 0);
  } finally {
    cleanup(ctx);
  }
});

test("during migration the target tier reserves the full object size", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 150 });
  try {
    const content = contentOf(100, 1);
    const id = await ctx.store.put("hot", streamOf(content), content.length);

    // The reservation is created synchronously before the first await of
    // the copy, so this put observes the in-flight migration.
    const migration = ctx.store.migrate(id, "cold");
    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 100, "source keeps full billing");
    assert.equal(usage.cold.reservedBytes, 100, "target reserves full size");
    assert.equal(usage.cold.usedBytes, 0);

    // 50 bytes remain free in cold; 51 must be rejected.
    const tooBig = contentOf(51, 2);
    await assert.rejects(
      ctx.store.put("cold", streamOf(tooBig), tooBig.length),
      CapacityExceededError,
    );
    const fits = contentOf(50, 3);
    const other = await ctx.store.put("cold", streamOf(fits), fits.length);

    await migration;
    assert.equal(ctx.store.stat(id).tier, "cold");
    assert.deepEqual(await ctx.store.read(id), content);
    assert.deepEqual(await ctx.store.read(other), fits);
    assert.equal(ctx.store.usage().cold.usedBytes, 150);
    assert.equal(ctx.store.usage().cold.reservedBytes, 0);
  } finally {
    cleanup(ctx);
  }
});

test("object stays readable while a migration is in flight", async () => {
  const ctx = makeStore({ hot: 4096, warm: 0, cold: 4096 });
  try {
    const content = contentOf(4096, 5);
    const id = await ctx.store.put("hot", streamOf(content), content.length);

    const migration = ctx.store.migrate(id, "cold");
    // Read while the copy is (likely) still in flight; retry a few times
    // to catch the window before the commit.
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await ctx.store.read(id), content);
    }
    await migration;
    assert.deepEqual(await ctx.store.read(id), content);
  } finally {
    cleanup(ctx);
  }
});

test("failed copy keeps the source object and frees the target reservation", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 100 });
  const coldDir = ctx.options.tiers.cold.dir;
  try {
    const content = contentOf(60, 1);
    const id = await ctx.store.put("hot", streamOf(content), content.length);

    // Make the target directory unwritable so the copy fails.
    fs.mkdirSync(coldDir, { recursive: true });
    fs.chmodSync(coldDir, 0o555);
    try {
      await assert.rejects(ctx.store.migrate(id, "cold"));
    } finally {
      fs.chmodSync(coldDir, 0o755);
    }

    assert.equal(ctx.store.stat(id).tier, "hot");
    assert.deepEqual(await ctx.store.read(id), content);
    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 60);
    assert.equal(usage.cold.usedBytes, 0);
    assert.equal(usage.cold.reservedBytes, 0);
    assert.equal(dirFiles(coldDir).length, 0);

    // The target tier is fully usable again.
    await ctx.store.migrate(id, "cold");
    assert.equal(ctx.store.stat(id).tier, "cold");
    assert.deepEqual(await ctx.store.read(id), content);
  } finally {
    cleanup(ctx);
  }
});

test("migrating an unknown object fails without side effects", async () => {
  const ctx = makeStore({ hot: 10, warm: 10, cold: 10 });
  try {
    await assert.rejects(ctx.store.migrate("nope", "cold"), ObjectNotFoundError);
    assert.equal(ctx.store.usage().cold.reservedBytes, 0);
  } finally {
    cleanup(ctx);
  }
});

test("concurrent migrations of the same object are serialized", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  try {
    const content = contentOf(80, 1);
    const id = await ctx.store.put("hot", streamOf(content), content.length);
    await Promise.all([
      ctx.store.migrate(id, "warm"),
      ctx.store.migrate(id, "cold"),
    ]);
    // First migration wins; the second one moves warm -> cold.
    assert.equal(ctx.store.stat(id).tier, "cold");
    assert.deepEqual(await ctx.store.read(id), content);
    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 0);
    assert.equal(usage.warm.usedBytes, 0);
    assert.equal(usage.cold.usedBytes, 80);
    assert.equal(usage.cold.reservedBytes, 0);
  } finally {
    cleanup(ctx);
  }
});
