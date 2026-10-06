import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanup,
  contentOf,
  dirBytes,
  makeStore,
  sha256,
  streamOf,
} from "./helpers";
import { ArchiveStore } from "../src/index";
import { TIERS } from "../src/types";

test("reopening the store preserves objects, ownership and accounting", async () => {
  const ctx = makeStore({ hot: 1000, warm: 1000, cold: 1000 });
  const a = contentOf(300, 1);
  const b = contentOf(200, 2);
  const c = contentOf(100, 3);
  let idA: string;
  let idB: string;
  let idC: string;
  try {
    idA = await ctx.store.put("hot", streamOf(a), a.length);
    idB = await ctx.store.put("warm", streamOf(b), b.length);
    idC = await ctx.store.put("hot", streamOf(c), c.length);
    await ctx.store.migrate(idA, "cold");
    ctx.store.close();

    const reopened = ArchiveStore.open(ctx.options);
    try {
      assert.equal(reopened.stat(idA).tier, "cold");
      assert.equal(reopened.stat(idB).tier, "warm");
      assert.equal(reopened.stat(idC).tier, "hot");
      assert.equal(reopened.stat(idA).sha256, sha256(a));
      assert.deepEqual(await reopened.read(idA), a);
      assert.deepEqual(await reopened.read(idB), b);
      assert.deepEqual(await reopened.read(idC), c);

      const usage = reopened.usage();
      assert.equal(usage.hot.usedBytes, 100);
      assert.equal(usage.warm.usedBytes, 200);
      assert.equal(usage.cold.usedBytes, 300);
      assert.equal(usage.hot.reservedBytes, 0);
      assert.equal(usage.warm.reservedBytes, 0);
      assert.equal(usage.cold.reservedBytes, 0);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});

test("reopening with a different capacity is rejected", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  try {
    ctx.store.close();
    const other = {
      ...ctx.options,
      tiers: {
        ...ctx.options.tiers,
        hot: { ...ctx.options.tiers.hot, capacityBytes: 200 },
      },
    };
    assert.throws(() => ArchiveStore.open(other), /capacity mismatch/);
  } finally {
    cleanup(ctx);
  }
});

test("after a mixed workload, disk bytes per tier match the ledger", async () => {
  const ctx = makeStore({ hot: 500, warm: 500, cold: 500 });
  const contents: Buffer[] = [];
  const ids: string[] = [];
  try {
    const sizes = [120, 80, 200, 50, 90];
    const tiers = ["hot", "warm", "cold", "hot", "warm"] as const;
    for (let i = 0; i < sizes.length; i++) {
      const content = contentOf(sizes[i], i + 1);
      contents.push(content);
      ids.push(await ctx.store.put(tiers[i], streamOf(content), content.length));
    }
    await ctx.store.migrate(ids[0], "cold");
    await ctx.store.migrate(ids[3], "warm");
    await ctx.store.migrate(ids[2], "hot");

    // Every successful object reads back byte-for-byte.
    for (let i = 0; i < ids.length; i++) {
      assert.deepEqual(await ctx.store.read(ids[i]), contents[i]);
      assert.equal(ctx.store.stat(ids[i]).sha256, sha256(contents[i]));
    }

    // Independent disk accounting matches the library's records.
    const usage = ctx.store.usage();
    for (const tier of TIERS) {
      assert.equal(
        dirBytes(ctx.options.tiers[tier].dir),
        usage[tier].usedBytes,
        `tier ${tier} disk bytes must match ledger`,
      );
      assert.equal(usage[tier].reservedBytes, 0);
    }

    // And it still matches after a reopen.
    ctx.store.close();
    const reopened = ArchiveStore.open(ctx.options);
    try {
      const usageAfter = reopened.usage();
      for (const tier of TIERS) {
        assert.equal(dirBytes(ctx.options.tiers[tier].dir), usageAfter[tier].usedBytes);
      }
      for (let i = 0; i < ids.length; i++) {
        assert.deepEqual(await reopened.read(ids[i]), contents[i]);
      }
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});
