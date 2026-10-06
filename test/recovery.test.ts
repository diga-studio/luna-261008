import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  cleanup,
  contentOf,
  dirFiles,
  makeStore,
  streamOf,
} from "./helpers";
import { ArchiveStore } from "../src/index";
import { MetadataDb } from "../src/db";

test("crashed put: temp file and reservation are cleaned on reopen", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  try {
    ctx.store.close();

    const fixture = path.join(__dirname, "fixtures", "crash_put.js");
    assert.throws(() =>
      execFileSync(process.execPath, [fixture, ctx.root], { stdio: "pipe" }),
    );

    // The crashed process left a reservation and a partial temp file.
    const reopened = ArchiveStore.open(ctx.options);
    try {
      const usage = reopened.usage();
      assert.equal(usage.hot.usedBytes, 0);
      assert.equal(usage.hot.reservedBytes, 0);
      assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);

      // The whole capacity is usable again.
      const content = contentOf(100, 1);
      const id = await reopened.put("hot", streamOf(content), content.length);
      assert.deepEqual(await reopened.read(id), content);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});

test("crashed migration before commit: source kept, target temp removed", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  let id: string;
  try {
    const content = contentOf(60, 1);
    id = await ctx.store.put("hot", streamOf(content), content.length);
    ctx.store.close();

    // Simulate a crash mid-copy: reservation row + partial temp file.
    const db = new MetadataDb(ctx.options.dbPath);
    db.createReservation({
      id: "crash-res",
      tier: "cold",
      sizeBytes: 60,
      kind: "migration",
      objectId: id,
      tmpName: `${id}.part`,
      capacityBytes: 100,
    });
    db.close();
    fs.writeFileSync(path.join(ctx.options.tiers.cold.dir, `${id}.part`), content.subarray(0, 20));

    const reopened = ArchiveStore.open(ctx.options);
    try {
      assert.equal(reopened.stat(id).tier, "hot");
      assert.deepEqual(await reopened.read(id), content);
      const usage = reopened.usage();
      assert.equal(usage.hot.usedBytes, 60);
      assert.equal(usage.cold.usedBytes, 0);
      assert.equal(usage.cold.reservedBytes, 0);
      assert.equal(dirFiles(ctx.options.tiers.cold.dir).length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});

test("crashed migration after source delete: move is completed on reopen", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  let id: string;
  try {
    const content = contentOf(60, 1);
    id = await ctx.store.put("hot", streamOf(content), content.length);
    ctx.store.close();

    // Simulate a crash in the window between the source unlink and the
    // metadata commit: target file complete, source gone, reservation open.
    fs.renameSync(
      path.join(ctx.options.tiers.hot.dir, `${id}.bin`),
      path.join(ctx.options.tiers.cold.dir, `${id}.bin`),
    );
    const db = new MetadataDb(ctx.options.dbPath);
    db.createReservation({
      id: "crash-res",
      tier: "cold",
      sizeBytes: 60,
      kind: "migration",
      objectId: id,
      tmpName: `${id}.part`,
      capacityBytes: 100,
    });
    db.close();

    const reopened = ArchiveStore.open(ctx.options);
    try {
      assert.equal(reopened.stat(id).tier, "cold");
      assert.deepEqual(await reopened.read(id), content);
      const usage = reopened.usage();
      assert.equal(usage.hot.usedBytes, 0);
      assert.equal(usage.cold.usedBytes, 60);
      assert.equal(usage.cold.reservedBytes, 0);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});

test("crashed put after metadata commit: rename is completed on reopen", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  let id: string;
  try {
    const content = contentOf(50, 1);
    id = await ctx.store.put("hot", streamOf(content), content.length);
    ctx.store.close();

    // Simulate a crash between the metadata commit and the rename:
    // object row exists, content still under its temp name.
    fs.renameSync(
      path.join(ctx.options.tiers.hot.dir, `${id}.bin`),
      path.join(ctx.options.tiers.hot.dir, `${id}.part`),
    );

    const reopened = ArchiveStore.open(ctx.options);
    try {
      assert.equal(reopened.stat(id).tier, "hot");
      assert.deepEqual(await reopened.read(id), content);
      assert.deepEqual(dirFiles(ctx.options.tiers.hot.dir), [`${id}.bin`]);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});

test("orphan files with no metadata are swept on reopen", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  try {
    const content = contentOf(30, 1);
    const id = await ctx.store.put("warm", streamOf(content), content.length);
    ctx.store.close();

    // Junk from an imaginary crash: unknown final and temp files.
    fs.writeFileSync(path.join(ctx.options.tiers.hot.dir, "deadbeef.bin"), "junk");
    fs.writeFileSync(path.join(ctx.options.tiers.warm.dir, "deadbeef.part"), "junk");

    const reopened = ArchiveStore.open(ctx.options);
    try {
      assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);
      assert.deepEqual(dirFiles(ctx.options.tiers.warm.dir), [`${id}.bin`]);
      assert.deepEqual(await reopened.read(id), content);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});

test("crashed put between rename and commit leaves no trace", async () => {
  const ctx = makeStore({ hot: 100, warm: 100, cold: 100 });
  try {
    ctx.store.close();

    // Simulate a crash after the temp file was renamed but before the
    // metadata commit: an open put reservation plus a final-named file
    // no object row refers to.
    const orphanId = "11111111-2222-3333-4444-555555555555";
    fs.mkdirSync(ctx.options.tiers.hot.dir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.options.tiers.hot.dir, `${orphanId}.bin`),
      contentOf(70, 4),
    );
    const db = new MetadataDb(ctx.options.dbPath);
    db.createReservation({
      id: orphanId,
      tier: "hot",
      sizeBytes: 70,
      kind: "put",
      objectId: null,
      tmpName: `${orphanId}.part`,
      capacityBytes: 100,
    });
    db.close();

    const reopened = ArchiveStore.open(ctx.options);
    try {
      const usage = reopened.usage();
      assert.equal(usage.hot.usedBytes, 0);
      assert.equal(usage.hot.reservedBytes, 0);
      assert.equal(dirFiles(ctx.options.tiers.hot.dir).length, 0);

      const content = contentOf(100, 5);
      const id = await reopened.put("hot", streamOf(content), content.length);
      assert.deepEqual(await reopened.read(id), content);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(ctx);
  }
});
