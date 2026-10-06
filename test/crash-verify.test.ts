import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { BackupRepairStore, EMPTY_REPORT } from "../src/index.js";
import {
  buildFixture,
  FULL_BLOCK,
  makeBytes,
  makeRepoDir,
  removeRepoDir,
  sha256hex,
} from "./helpers.js";

const HASH_A = sha256hex(makeBytes(1, FULL_BLOCK));
const BODY_A = makeBytes(1, FULL_BLOCK);
const HASH_B = sha256hex(makeBytes(2, FULL_BLOCK));
const HASH_C = sha256hex(makeBytes(3, 100));
const BODY_C = makeBytes(3, 100);

/** 双坏块仓库：A、B 均损坏，C 正常。 */
async function setupRepo() {
  const dir = await makeRepoDir();
  const fixture = buildFixture([
    [
      { seed: 1, length: FULL_BLOCK },
      { seed: 3, length: 100 },
    ],
    [
      { seed: 2, length: FULL_BLOCK },
      { seed: 1, length: FULL_BLOCK },
    ],
  ]);
  const corrupt = (body: Uint8Array) => {
    const copy = Uint8Array.from(body);
    copy[0] = copy[0]! ^ 0xff;
    return copy;
  };
  const store = await BackupRepairStore.open(dir);
  await store.import(fixture.versions, [
    { hash: HASH_A, data: corrupt(BODY_A) },
    { hash: HASH_B, data: corrupt(makeBytes(2, FULL_BLOCK)) },
    { hash: HASH_C, data: BODY_C },
  ]);
  await store.verify();
  await store.close();
  return { dir, fixture };
}

test("完整校验被中断：此前完整报告保持可用，不混入未完成结果", async () => {
  const { dir } = await setupRepo();
  try {
    // 修好 A，报告变为只剩 B。
    const store = await BackupRepairStore.open(dir);
    await store.repairBlock(HASH_A, [BODY_A]);
    const stable = await store.getReport();
    assert.deepEqual(stable.entries.map((e) => e.hash), [HASH_B]);
    await store.close();
    const reportFile = path.join(dir, "report.json");
    const stableBytes = await fs.readFile(reportFile);

    // 再次完整校验，在报告替换前一刻“进程终止”。
    const crashed = await BackupRepairStore.open(dir, {
      verifyHooks: {
        beforeReportSave: () => {
          throw new Error("模拟进程终止：校验中断");
        },
      },
    });
    await assert.rejects(crashed.verify(), /模拟进程终止/);

    // 重新打开：报告仍是此前完整版本，临时文件已清理。
    const reopened = await BackupRepairStore.open(dir);
    assert.deepEqual(await reopened.getReport(), stable);
    assert.deepEqual(await fs.readFile(reportFile), stableBytes);
    const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    await reopened.close();

    // 重新执行完整校验：正常完成并替换报告。
    const redone = await BackupRepairStore.open(dir);
    const report = await redone.verify();
    assert.deepEqual(report.entries.map((e) => e.hash), [HASH_B]);
    assert.deepEqual(report.damagedVersions, ["v2"]);
    await redone.close();
  } finally {
    await removeRepoDir(dir);
  }
});


test("从未完成过校验时被中断：报告仍为空报告", async () => {
  const dir = await makeRepoDir();
  try {
    const fixture = buildFixture([[{ seed: 1, length: FULL_BLOCK }]]);
    const store = await BackupRepairStore.open(dir);
    await store.import(fixture.versions, []);
    await store.close();

    const crashed = await BackupRepairStore.open(dir, {
      verifyHooks: {
        beforeReportSave: () => {
          throw new Error("模拟进程终止：校验中断");
        },
      },
    });
    await assert.rejects(crashed.verify(), /模拟进程终止/);

    const reopened = await BackupRepairStore.open(dir);
    assert.deepEqual(await reopened.getReport(), EMPTY_REPORT);
    await reopened.close();
  } finally {
    await removeRepoDir(dir);
  }
});
