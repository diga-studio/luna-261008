import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PipeForge, type Inspection } from "../src/index.js";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function makeWorkspace(): Promise<{ root: string; src: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pipeforge-test-"));
  const src = join(root, "sources");
  await mkdir(src, { recursive: true });
  return { root, src, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function writeSource(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

/** Verify every retained version and the delivery file byte-for-byte against metadata. */
async function verifyOnDisk(inspection: Inspection, outDir: string): Promise<void> {
  const deliveryInfo = await stat(inspection.deliveryPath);
  assert.ok(deliveryInfo.isFile(), "delivery path must be a regular file");

  const seen: number[] = [];
  for (const v of inspection.versions) {
    const bytes = await readFile(join(outDir, "versions", String(v.version)));
    assert.equal(bytes.length, v.size, `version ${v.version} size`);
    assert.equal(sha256(bytes), v.sha256, `version ${v.version} sha256`);
    seen.push(v.version);
  }
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    seen,
    "versions listed ascending",
  );

  if (inspection.currentVersion !== null) {
    const current = inspection.versions.find((v) => v.version === inspection.currentVersion);
    assert.ok(current, "current version must be retained");
    const delivered = await readFile(inspection.deliveryPath);
    assert.equal(sha256(delivered), current!.sha256, "delivery bytes must match current version");
  }
}

test("retrying a committed publish requestId is idempotent", async () => {
  const { root, src, cleanup } = await makeWorkspace();
  try {
    const forge = new PipeForge(join(root, "store"));
    const outDir = join(root, "store", "outputs", "app");

    const srcA = await writeSource(src, "a.bin", "alpha-content");
    const srcB = await writeSource(src, "b.bin", "beta-content");

    const v1 = await forge.publish("app", "req-1", srcA);
    assert.equal(v1, 1);
    const v2 = await forge.publish("app", "req-2", srcB);
    assert.equal(v2, 2);

    const before = await forge.inspect("app");
    const deliveredBefore = await readFile(before.deliveryPath);

    // Retry both committed requests with identical parameters.
    assert.equal(await forge.publish("app", "req-1", srcA), 1);
    assert.equal(await forge.publish("app", "req-2", srcB), 2);

    const after = await forge.inspect("app");
    assert.deepEqual(after, before, "retry must not append versions or change metadata");
    const deliveredAfter = await readFile(after.deliveryPath);
    assert.ok(deliveredAfter.equals(deliveredBefore), "retry must not change delivery bytes");
    assert.equal(sha256(deliveredAfter), sha256(Buffer.from("beta-content")));

    await verifyOnDisk(after, outDir);
  } finally {
    await cleanup();
  }
});

test("retention: rollback from evicted version's request still idempotent", async () => {
  const { root, src, cleanup } = await makeWorkspace();
  try {
    const forge = new PipeForge(join(root, "store"));
    const outDir = join(root, "store", "outputs", "app");

    // Publish 20 versions, keeping each source file for later retries.
    const sources: string[] = [];
    for (let i = 1; i <= 20; i++) {
      sources.push(await writeSource(src, `v${i}.bin`, `content-of-version-${i}`));
    }
    for (let i = 1; i <= 20; i++) {
      assert.equal(await forge.publish("app", `publish-${i}`, sources[i - 1]), i);
    }

    // Rollback to version 1 -> creates version 21, evicting version 1.
    const v21 = await forge.rollback("app", "rollback-to-1", 1);
    assert.equal(v21, 21);

    let snap = await forge.inspect("app");
    assert.equal(snap.currentVersion, 21);
    assert.equal(snap.versions.length, 20);
    assert.deepEqual(
      snap.versions.map((v) => v.version),
      Array.from({ length: 20 }, (_, i) => i + 2),
      "only versions 2..21 are retained",
    );
    const v21rec = snap.versions.find((v) => v.version === 21)!;
    assert.equal(v21rec.sha256, sha256(Buffer.from("content-of-version-1")));
    await verifyOnDisk(snap, outDir);

    // Retry the rollback request: must return 21 even though version 1 is evicted.
    assert.equal(await forge.rollback("app", "rollback-to-1", 1), 21);
    snap = await forge.inspect("app");
    assert.equal(snap.currentVersion, 21);
    assert.equal(snap.versions.length, 20);
    const delivered = await readFile(snap.deliveryPath);
    assert.ok(delivered.equals(Buffer.from("content-of-version-1")));

    // Retry version 1's publish request: must return 1 and not change anything.
    assert.equal(await forge.publish("app", "publish-1", sources[0]), 1);
    const after = await forge.inspect("app");
    assert.deepEqual(after, snap, "publish retry must not change current version or retention");
    await verifyOnDisk(after, outDir);
  } finally {
    await cleanup();
  }
});

test("rollback does not modify the original version", async () => {
  const { root, src, cleanup } = await makeWorkspace();
  try {
    const forge = new PipeForge(join(root, "store"));
    const outDir = join(root, "store", "outputs", "app");

    const srcA = await writeSource(src, "a.bin", "original");
    await forge.publish("app", "p1", srcA);
    await forge.rollback("app", "r1", 1);

    const v1bytes = await readFile(join(outDir, "versions", "1"));
    assert.ok(v1bytes.equals(Buffer.from("original")));
    const snap = await forge.inspect("app");
    assert.equal(snap.currentVersion, 2);
    assert.deepEqual(
      snap.versions.map((v) => v.version),
      [1, 2],
    );
    await verifyOnDisk(snap, outDir);
  } finally {
    await cleanup();
  }
});

test("requestId reuse with different parameters is rejected", async () => {
  const { root, src, cleanup } = await makeWorkspace();
  try {
    const forge = new PipeForge(join(root, "store"));
    const srcA = await writeSource(src, "a.bin", "one");
    const srcB = await writeSource(src, "b.bin", "two");

    await forge.publish("app", "req", srcA);
    await assert.rejects(forge.publish("app", "req", srcB), /different content/);
    await assert.rejects(forge.rollback("app", "req", 1), /different parameters/);
  } finally {
    await cleanup();
  }
});

test("rollback to a non-retained version fails for new requests", async () => {
  const { root, src, cleanup } = await makeWorkspace();
  try {
    const forge = new PipeForge(join(root, "store"));
    for (let i = 1; i <= 21; i++) {
      await forge.publish("app", `p${i}`, await writeSource(src, `v${i}.bin`, `c${i}`));
    }
    await assert.rejects(forge.rollback("app", "new-rollback", 1), /not retained/);
    await assert.rejects(forge.rollback("app", "another", 99), /not retained/);
  } finally {
    await cleanup();
  }
});

test("state survives across PipeForge instances (persistence)", async () => {
  const { root, src, cleanup } = await makeWorkspace();
  try {
    const storeDir = join(root, "store");
    const srcA = await writeSource(src, "a.bin", "persisted");

    const first = new PipeForge(storeDir);
    assert.equal(await first.publish("app", "req-1", srcA), 1);

    const second = new PipeForge(storeDir);
    assert.equal(await second.publish("app", "req-1", srcA), 1, "retry after restart");
    const snap = await second.inspect("app");
    assert.equal(snap.currentVersion, 1);
    assert.equal(snap.versions.length, 1);
  } finally {
    await cleanup();
  }
});
