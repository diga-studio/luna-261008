import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import {
  BackupRepairStore,
  EMPTY_REPORT,
  RepairRejectedError,
} from "../src/index.js";
import {
  buildFixture,
  makeBytes,
  chunkStream,
  FULL_BLOCK,
  makeRepoDir,
  originalBytes,
  reassemble,
  removeRepoDir,
  sha256hex,
} from "./helpers.js";

// 布局：A、B 两个坏块被多版本共享，且 A 在 v1 内重复引用。
//   v1: A C A C   （A、C 同版本重复引用）
//   v2: B A
//   v3: C
const layout = [
  [
    { seed: 1, length: FULL_BLOCK }, // A
    { seed: 3, length: 100 }, // C
    { seed: 1, length: FULL_BLOCK }, // A
    { seed: 3, length: 100 }, // C
  ],
  [
    { seed: 2, length: FULL_BLOCK }, // B
    { seed: 1, length: FULL_BLOCK }, // A
  ],
  [{ seed: 3, length: 100 }], // C
];

async function setupRepo(opts: { corruptA: boolean; missingB: boolean }) {
  const dir = await makeRepoDir();
  const fixture = buildFixture(layout);
  const hashA = sha256hex(makeBytes(1, FULL_BLOCK));
  const hashB = sha256hex(makeBytes(2, FULL_BLOCK));
  const hashC = sha256hex(makeBytes(3, 100));
  const blocks = [];
  // A：导入损坏数据（字节翻转）
  const bodyA = fixture.bodies.get(hashA)!;
  const corruptA = Uint8Array.from(bodyA);
  corruptA[0] = corruptA[0]! ^ 0xff;
  blocks.push({ hash: hashA, data: opts.corruptA ? corruptA : bodyA });
  // B：缺失（不导入）
  if (!opts.missingB) blocks.push({ hash: hashB, data: fixture.bodies.get(hashB)! });
  blocks.push({ hash: hashC, data: fixture.bodies.get(hashC)! });
  const store = await BackupRepairStore.open(dir);
  await store.import(fixture.versions, blocks);
  return { dir, fixture, store, hashA, hashB, hashC };
}

test("共享且重复引用的两个坏块：逐个修复并重组校验", async () => {
  const { dir, fixture, store, hashA, hashB } = await setupRepo({
    corruptA: true,
    missingB: true,
  });
  try {
    // 完整校验：A、B 损坏；重复引用不重复计数。
    const report = await store.verify();
    assert.equal(report.entries.length, 2);
    const entryA = report.entries.find((e) => e.hash === hashA)!;
    const entryB = report.entries.find((e) => e.hash === hashB)!;
    assert.deepEqual(entryA.versions, ["v1", "v2"]); // v1 内重复引用只计一次
    assert.deepEqual(entryB.versions, ["v2"]);
    assert.deepEqual(report.damagedVersions, ["v1", "v2"]);
    assert.equal(entryA.length, FULL_BLOCK);

    // 修好 A：仅解除 A 的损坏记录，v2 因 B 仍受损。
    const bodyA = fixture.bodies.get(hashA)!;
    const result = await store.repairBlock(hashA, chunkStream(bodyA, 65536));
    assert.equal(result.blockRewritten, true);
    const afterA = await store.getReport();
    assert.deepEqual(afterA.entries.map((e) => e.hash), [hashB]);
    assert.deepEqual(afterA.damagedVersions, ["v2"]);

    // 重复提交 A 的正确补传：幂等，不增加块副本。
    const again = await store.repairBlock(hashA, chunkStream(bodyA, 1 << 20));
    assert.equal(again.blockRewritten, false);
    const blockFiles = await fs.readdir(
      (await fs.readdir(dir)).includes("blocks") ? `${dir}/blocks/${hashA.slice(0, 2)}` : "",
    );
    assert.deepEqual(blockFiles, [hashA]);

    // 修好 B：报告清空。
    const bodyB = fixture.bodies.get(hashB)!;
    await store.repairBlock(hashB, chunkStream(bodyB, 300000));
    const final = await store.getReport();
    assert.deepEqual(final.entries, []);
    assert.deepEqual(final.damagedVersions, []);

    // 按清单重组的内容与原始字节一致。
    for (const version of fixture.versions) {
      const rebuilt = await reassemble((h) => store.blockPath(h), version);
      assert.deepEqual(rebuilt, originalBytes(fixture, version));
    }
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test("被拒绝的补传不改变块与报告", async () => {
  const { dir, fixture, store, hashA } = await setupRepo({
    corruptA: true,
    missingB: true,
  });
  try {
    await store.verify();
    const before = await store.getReport();
    const bodyA = fixture.bodies.get(hashA)!;

    // 长度不符
    await assert.rejects(
      store.repairBlock(hashA, [bodyA.subarray(0, bodyA.length - 1)]),
      (err: unknown) => err instanceof RepairRejectedError && err.reason === "length-mismatch",
    );
    // 内容不符（长度凑够但哈希不对）
    const wrong = Uint8Array.from(bodyA);
    wrong[5] = wrong[5]! ^ 0x01;
    await assert.rejects(
      store.repairBlock(hashA, chunkStream(wrong, 1 << 20)),
      (err: unknown) => err instanceof RepairRejectedError && err.reason === "hash-mismatch",
    );
    // 未被清单引用的哈希
    await assert.rejects(
      store.repairBlock(sha256hex(new Uint8Array(10)), [new Uint8Array(10)]),
      (err: unknown) => err instanceof RepairRejectedError && err.reason === "unknown-hash",
    );

    // 报告与块均未改变
    assert.deepEqual(await store.getReport(), before);
    const onDisk = await fs.readFile(store.blockPath(hashA));
    assert.notEqual(sha256hex(onDisk), hashA); // 仍是导入时的坏数据
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test("未校验前报告为空；重复导入被拒绝", async () => {
  const { dir, fixture, store } = await setupRepo({ corruptA: true, missingB: true });
  try {
    assert.deepEqual(await store.getReport(), EMPTY_REPORT);
    await assert.rejects(store.import(fixture.versions, []), /只允许一次/);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});
