import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BackupRepairStore, type Manifest } from '../src/index.js';
import { makeBlock, makeData, makeRepoDir, removeRepoDir, sha256Hex } from './helpers.js';

const P = makeBlock('val-P', 50_000);
const Q = makeBlock('val-Q', 70_000);

const manifest: Manifest = {
  versions: [
    { id: 'v1', files: [{ path: 'a', blocks: [
      { hash: P.hash, length: P.data.length },
      { hash: Q.hash, length: Q.data.length },
    ] }] },
  ],
};

test('validate 区分 missing / length-mismatch / hash-mismatch，并可随状态变化替换报告', async () => {
  const dir = await makeRepoDir();
  try {
    const store = await BackupRepairStore.open(dir);
    // P 完全缺失，Q 先写入错误长度。
    await store.import(manifest, [{ hash: Q.hash, data: makeData('q-short', 10) }]);

    let report = await store.validate();
    let byHash = new Map(report.corruptBlocks.map((e) => [e.hash, e.corruption]));
    assert.equal(byHash.get(P.hash), 'missing');
    assert.equal(byHash.get(Q.hash), 'length-mismatch');

    // 把 Q 改成长度正确但内容错误（模拟外部初始数据准备的另一种损坏）。
    // 注意：导入完成后块文件只应由修复操作改写，这里通过修复接口之外的
    // 直接文件写入来模拟“初始块文件损坏”的另一种形态，仅用于测试校验能力。
    const wrongQ = makeData('q-wrong', Q.data.length);
    await fs.writeFile(path.join(dir, 'blocks', Q.hash), wrongQ);
    report = await store.validate();
    byHash = new Map(report.corruptBlocks.map((e) => [e.hash, e.corruption]));
    assert.equal(byHash.get(Q.hash), 'hash-mismatch');

    // 全部修好后报告清空。
    await store.submitRepair(P.hash, P.data);
    await store.submitRepair(Q.hash, Q.data);
    report = await store.validate();
    assert.deepEqual(report.corruptBlocks, []);
    assert.deepEqual(report.damagedVersions, []);
    assert.equal(sha256Hex(await fs.readFile(path.join(dir, 'blocks', P.hash))), P.hash);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('导入清单之外的块被拒绝', async () => {
  const dir = await makeRepoDir();
  try {
    const store = await BackupRepairStore.open(dir);
    const stranger = makeBlock('stranger', 100);
    await assert.rejects(
      store.import(manifest, [{ hash: stranger.hash, data: stranger.data }]),
      /not referenced/,
    );
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('操作串行执行：并发的校验与修复最终状态一致', async () => {
  const dir = await makeRepoDir();
  try {
    const store = await BackupRepairStore.open(dir);
    await store.import(manifest, []);
    // 不等待地连发：先校验（会发现 P、Q 都缺失），再修复 P，再校验。
    const p1 = store.validate();
    const p2 = store.submitRepair(P.hash, P.data);
    const p3 = store.validate();
    const [first, repaired, second] = await Promise.all([p1, p2, p3]);
    assert.equal(first.corruptBlocks.length, 2);
    assert.equal(repaired.status, 'repaired');
    // 最后一次校验看到的是修复后的状态。
    assert.deepEqual(second.corruptBlocks.map((e) => e.hash), [Q.hash]);
    assert.deepEqual((await store.getReport())!.corruptBlocks.map((e) => e.hash), [Q.hash]);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('关闭后的操作被拒绝', async () => {
  const dir = await makeRepoDir();
  try {
    const store = await BackupRepairStore.open(dir);
    await store.import(manifest, []);
    await store.close();
    await assert.rejects(store.validate(), /closed/);
    await assert.rejects(store.getReport(), /closed/);
  } finally {
    await removeRepoDir(dir);
  }
});

test('未导入清单时的操作报错', async () => {
  const dir = await makeRepoDir();
  try {
    const store = await BackupRepairStore.open(dir);
    await assert.rejects(store.validate(), /not imported/);
    await assert.rejects(store.submitRepair(P.hash, P.data), /not imported/);
    assert.equal(await store.getReport(), null);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('清单校验：坏哈希、坏长度、重复版本标识都被拒绝', async () => {
  const dir = await makeRepoDir();
  try {
    const store = await BackupRepairStore.open(dir);
    const badHash: Manifest = { versions: [{ id: 'v', files: [{ path: 'f', blocks: [{ hash: 'xyz', length: 1 }] }] }] };
    await assert.rejects(store.import(badHash, []), /invalid manifest/);

    const badLength: Manifest = { versions: [{ id: 'v', files: [{ path: 'f', blocks: [{ hash: P.hash, length: 5 * 1024 * 1024 }] }] }] };
    await assert.rejects(store.import(badLength, []), /invalid manifest/);

    const dupVersion: Manifest = { versions: [
      { id: 'v', files: [] },
      { id: 'v', files: [] },
    ] };
    await assert.rejects(store.import(dupVersion, []), /invalid manifest/);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});
