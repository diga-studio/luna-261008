import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  BackupRepairStore,
  type OpenOptions,
  type RepairHooks,
} from "../src/index.js";
import {
  brokenStream,
  buildFixture,
  chunkStream,
  FULL_BLOCK,
  makeBytes,
  makeRepoDir,
  removeRepoDir,
  sha256hex,
} from "./helpers.js";

const HASH_A = sha256hex(makeBytes(1, FULL_BLOCK));
const BODY_A = makeBytes(1, FULL_BLOCK);
const HASH_C = sha256hex(makeBytes(3, 100));
const BODY_C = makeBytes(3, 100);

/** 单坏块仓库：v1、v2 共享 A（损坏），C 正常。 */
async function setupCorruptRepo(options?: OpenOptions) {
  const dir = await makeRepoDir();
  const fixture = buildFixture([
    [
      { seed: 1, length: FULL_BLOCK },
      { seed: 3, length: 100 },
    ],
    [
      { seed: 1, length: FULL_BLOCK },
      { seed: 3, length: 100 },
      { seed: 1, length: FULL_BLOCK },
    ],
  ]);
  const corruptA = Uint8Array.from(BODY_A);
  corruptA[7] = corruptA[7]! ^ 0xff;
  const store = await BackupRepairStore.open(dir, options);
  await store.import(fixture.versions, [
    { hash: HASH_A, data: corruptA },
    { hash: HASH_C, data: BODY_C },
  ]);
  await store.verify();
  await store.close();
  return { dir, fixture };
}

class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`模拟进程终止：${point}`);
    this.name = "SimulatedCrash";
  }
}

function crashAt(point: keyof RepairHooks): OpenOptions {
  return {
    repairHooks: {
      [point]: () => {
        throw new SimulatedCrash(point);
      },
    },
  };
}

async function expectOldState(dir: string): Promise<void> {
  const store = await BackupRepairStore.open(dir);
  const report = await store.getReport();
  assert.deepEqual(report.entries.map((e) => e.hash), [HASH_A]);
  assert.deepEqual(report.damagedVersions, ["v1", "v2"]);
  const onDisk = new Uint8Array(await fs.readFile(store.blockPath(HASH_A)));
  assert.notEqual(sha256hex(onDisk), HASH_A, "块应保持原（损坏）内容");
  await store.close();
}

async function expectRepaired(dir: string): Promise<void> {
  const store = await BackupRepairStore.open(dir);
  const report = await store.getReport();
  assert.deepEqual(report.entries, []);
  assert.deepEqual(report.damagedVersions, []);
  const onDisk = new Uint8Array(await fs.readFile(store.blockPath(HASH_A)));
  assert.deepEqual(onDisk, BODY_A);
  await store.close();
}

test("崩溃于 journal 落盘后、块提交前：收敛到原块+原报告，可重新补传", async () => {
  const { dir } = await setupCorruptRepo();
  try {
    const crashed = await BackupRepairStore.open(dir, crashAt("afterJournalWrite"));
    await assert.rejects(crashed.repairBlock(HASH_A, [BODY_A]), SimulatedCrash);

    await expectOldState(dir);
    // 重新打开后重复补传，修复成功。
    const store = await BackupRepairStore.open(dir);
    await store.repairBlock(HASH_A, chunkStream(BODY_A, 1 << 20));
    await store.close();
    await expectRepaired(dir);
  } finally {
    await removeRepoDir(dir);
  }
});

test("崩溃于块已提交、报告未更新：恢复后两侧一致，且正文读取量受限", async () => {
  const { dir } = await setupCorruptRepo();
  try {
    const crashed = await BackupRepairStore.open(dir, crashAt("afterBlockCommit"));
    await assert.rejects(crashed.repairBlock(HASH_A, [BODY_A]), SimulatedCrash);

    // 重新打开：自动恢复应补齐报告更新，只读取这一个块的正文。
    const store = await BackupRepairStore.open(dir);
    assert.equal(store.recoveryBlockBytesRead, FULL_BLOCK);
    assert.ok(store.recoveryBlockBytesRead <= 16 * 1024 * 1024);
    const report = await store.getReport();
    assert.deepEqual(report.entries, []);
    const onDisk = new Uint8Array(await fs.readFile(store.blockPath(HASH_A)));
    assert.deepEqual(onDisk, BODY_A);
    await store.close();

    // 重复补传正确数据：幂等。
    const again = await BackupRepairStore.open(dir);
    const result = await again.repairBlock(HASH_A, chunkStream(BODY_A, 1 << 20));
    assert.equal(result.blockRewritten, false);
    await again.close();
    await expectRepaired(dir);
  } finally {
    await removeRepoDir(dir);
  }
});

test("崩溃于报告已更新、journal 未删：恢复为无操作", async () => {
  const { dir } = await setupCorruptRepo();
  try {
    const crashed = await BackupRepairStore.open(dir, crashAt("afterReportSave"));
    await assert.rejects(crashed.repairBlock(HASH_A, [BODY_A]), SimulatedCrash);
    await expectRepaired(dir);
  } finally {
    await removeRepoDir(dir);
  }
});

test("补传流只写了一部分就中断：原状态不变，重传后成功", async () => {
  const { dir } = await setupCorruptRepo();
  try {
    const store = await BackupRepairStore.open(dir);
    await assert.rejects(
      store.repairBlock(HASH_A, brokenStream(BODY_A, FULL_BLOCK / 2)),
      /模拟进程终止/,
    );
    await store.close();

    // 暂存残留被清理，原块与原报告不变。
    await expectOldState(dir);
    const staging = path.join(dir, "staging");
    const leftovers = await fs.readdir(staging).catch(() => [] as string[]);
    assert.deepEqual(leftovers, []);

    const retry = await BackupRepairStore.open(dir);
    await retry.repairBlock(HASH_A, chunkStream(BODY_A, 1 << 20));
    await retry.close();
    await expectRepaired(dir);
  } finally {
    await removeRepoDir(dir);
  }
});

test("已确认成功的修复在重启后不回退", async () => {
  const { dir } = await setupCorruptRepo();
  try {
    const store = await BackupRepairStore.open(dir);
    await store.repairBlock(HASH_A, chunkStream(BODY_A, 1 << 20));
    await store.close();
    // 多次重开都保持修复结果。
    await expectRepaired(dir);
    await expectRepaired(dir);
  } finally {
    await removeRepoDir(dir);
  }
});

test("大量版本引用下单块恢复的正文读取量不超过 16 MiB", async () => {
  const dir = await makeRepoDir();
  try {
    // 2000 个版本、共 4000 条引用共享同一个坏块。
    const layout = Array.from({ length: 2000 }, () => [
      { seed: 1, length: FULL_BLOCK },
      { seed: 3, length: 100 },
    ]);
    const fixture = buildFixture(layout);
    const corruptA = Uint8Array.from(BODY_A);
    corruptA[0] = corruptA[0]! ^ 0xff;
    const store = await BackupRepairStore.open(dir);
    await store.import(fixture.versions, [
      { hash: HASH_A, data: corruptA },
      { hash: HASH_C, data: BODY_C },
    ]);
    await store.verify();
    await store.close();

    const crashed = await BackupRepairStore.open(dir, crashAt("afterBlockCommit"));
    await assert.rejects(crashed.repairBlock(HASH_A, [BODY_A]), SimulatedCrash);

    const recovered = await BackupRepairStore.open(dir);
    assert.ok(
      recovered.recoveryBlockBytesRead <= 16 * 1024 * 1024,
      `恢复读取量 ${recovered.recoveryBlockBytesRead} 超过 16 MiB`,
    );
    assert.equal(recovered.recoveryBlockBytesRead, FULL_BLOCK);
    const report = await recovered.getReport();
    assert.deepEqual(report.entries, []);
    assert.deepEqual(report.damagedVersions, []);
    await recovered.close();
  } finally {
    await removeRepoDir(dir);
  }
});
