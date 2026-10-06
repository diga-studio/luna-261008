import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanup,
  contentOf,
  dirFiles,
  failingStream,
  makeStore,
  sha256,
  streamOf,
} from "./helpers";
import { CapacityExceededError, ObjectNotFoundError } from "../src/index";

test("put stores an object and reads it back byte-for-byte", async () => {
  const ctx = makeStore({ hot: 1024, warm: 1024, cold: 1024 });
  try {
    const content = contentOf(500);
    const id = await ctx.store.put("hot", streamOf(content, 64), content.length);

    const info = ctx.store.stat(id);
    assert.equal(info.tier, "hot");
    assert.equal(info.sizeBytes, 500);
    assert.equal(info.sha256, sha256(content));

    const back = await ctx.store.read(id);
    assert.deepEqual(back, content);

    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 500);
    assert.equal(usage.hot.reservedBytes, 0);
    assert.equal(usage.hot.availableBytes, 524);
  } finally {
    cleanup(ctx);
  }
});

test("put may fill a tier exactly to its capacity", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 0 });
  try {
    const a = contentOf(60, 1);
    const b = contentOf(40, 2);
    await ctx.store.put("hot", streamOf(a), a.length);
    await ctx.store.put("hot", streamOf(b), b.length);
    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 100);
    assert.equal(usage.hot.availableBytes, 0);
  } finally {
    cleanup(ctx);
  }
});

test("put exceeding capacity by one byte is rejected and leaves no trace", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 0 });
  try {
    const a = contentOf(100, 1);
    await ctx.store.put("hot", streamOf(a), a.length);

    const extra = contentOf(1, 7);
    await assert.rejects(
      ctx.store.put("hot", streamOf(extra), extra.length),
      CapacityExceededError,
    );

    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 100);
    assert.equal(usage.hot.reservedBytes, 0);
    assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 1);
  } finally {
    cleanup(ctx);
  }
});

test("put larger than the whole tier is rejected before writing", async () => {
  const ctx = makeStore({ hot: 10, warm: 0, cold: 0 });
  try {
    const content = contentOf(11, 3);
    await assert.rejects(
      ctx.store.put("hot", streamOf(content), content.length),
      CapacityExceededError,
    );
    assert.equal(ctx.store.usage().hot.usedBytes, 0);
    assert.equal(ctx.store.usage().hot.reservedBytes, 0);
    assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);
  } finally {
    cleanup(ctx);
  }
});

test("interrupted stream is not published and its space is reusable", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 0 });
  try {
    const part = contentOf(40, 1);
    await assert.rejects(
      ctx.store.put(
        "hot",
        failingStream([part], new Error("connection reset")),
        100,
      ),
      /connection reset/,
    );

    const usage = ctx.store.usage();
    assert.equal(usage.hot.usedBytes, 0);
    assert.equal(usage.hot.reservedBytes, 0);
    assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);

    // The full capacity is available again.
    const full = contentOf(100, 2);
    const id = await ctx.store.put("hot", streamOf(full), full.length);
    assert.deepEqual(await ctx.store.read(id), full);
  } finally {
    cleanup(ctx);
  }
});

test("stream shorter than declared length is rejected and cleaned up", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 0 });
  try {
    const content = contentOf(30, 1);
    await assert.rejects(
      ctx.store.put("hot", streamOf(content), 50),
      /length mismatch/,
    );
    assert.equal(ctx.store.usage().hot.usedBytes, 0);
    assert.equal(ctx.store.usage().hot.reservedBytes, 0);
    assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);
  } finally {
    cleanup(ctx);
  }
});

test("stream longer than declared length is rejected and cleaned up", async () => {
  const ctx = makeStore({ hot: 100, warm: 0, cold: 0 });
  try {
    const content = contentOf(60, 1);
    await assert.rejects(
      ctx.store.put("hot", streamOf(content), 50),
      /more bytes than declared/,
    );
    assert.equal(ctx.store.usage().hot.usedBytes, 0);
    assert.equal(ctx.store.usage().hot.reservedBytes, 0);
    assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);
  } finally {
    cleanup(ctx);
  }
});

test("stat and read of unknown ids fail with ObjectNotFoundError", async () => {
  const ctx = makeStore({ hot: 10, warm: 0, cold: 0 });
  try {
    assert.throws(() => ctx.store.stat("nope"), ObjectNotFoundError);
    await assert.rejects(ctx.store.read("nope"), ObjectNotFoundError);
  } finally {
    cleanup(ctx);
  }
});

test("zero-length object round-trips", async () => {
  const ctx = makeStore({ hot: 10, warm: 0, cold: 0 });
  try {
    const id = await ctx.store.put("hot", streamOf(Buffer.alloc(0)), 0);
    assert.equal(ctx.store.stat(id).sizeBytes, 0);
    assert.deepEqual(await ctx.store.read(id), Buffer.alloc(0));
  } finally {
    cleanup(ctx);
  }
});
