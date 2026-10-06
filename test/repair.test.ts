import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BackupRepairStore, type Manifest } from '../src/index.js';
import {
  chunkEvery,
  concatBytes,
  makeBlock,
  makeData,
  makeRepoDir,
  reassembleVersion,
  removeRepoDir,
  sha256Hex,
} from './helpers.js';

// 四个块：A 被 v1 重复引用且共享给 v2；B 被 v2/v3 共享；C 健康；D 仅 v1。
const A = makeBlock('block-A', 100_000);
const B = makeBlock('block-B', 200_000);
const C = makeBlock('block-C', 150_000);
const D = makeBlock('block-D', 64_000);

const manifest: Manifest = {
  versions: [
    { id: 'v1', files: [{ path: 'v1/f1', blocks: [
      { hash: A.hash, length: A.data.length },
      { hash: A.hash, length: A.data.length }, // 同一版本内重复引用
      { hash: D.hash, length: D.data.length },
    ] }] },
    { id: 'v2', files: [
      { path: 'v2/f1', blocks: [{ hash: A.hash, length: A.data.length }] },
      { path: 'v2/f2', blocks: [{ hash: B.hash, length: B.data.length }] },
    ] },
    { id: 'v3', files: [{ path: 'v3/f1', blocks: [
      { hash: B.hash, length: B.data.length },
      { hash: C.hash, length: C.data.length },
    ] }] },
  ],
};

let dir: string;

before(async () => {
  dir = await makeRepoDir();
});

after(async () => {
  await removeRepoDir(dir);
});

test('import, validate, repair one by one, reassemble matches originals', async () => {
  const store = await BackupRepairStore.open(dir);

  // 初始块：A 内容损坏（同长度错误字节）、B 缺失、C 正确、D 长度不对。
  const corruptA = makeData('corrupt-A', A.data.length);
  const shortD = makeData('short-D', D.data.length - 10);
  await store.import(manifest, [
    { hash: A.hash, data: corruptA },
    { hash: C.hash, data: C.data },
    { hash: D.hash, data: shortD },
  ]);

  // 完整校验之前没有报告。
  assert.equal(await store.getReport(), null);

  // 被拒绝的补传：长度不对。
  const rejectedLength = await store.submitRepair(B.hash, [makeData('x', 123)]);
  assert.equal(rejectedLength.status, 'rejected');
  // 被拒绝的补传：长度对但内容不对。
  const rejectedHash = await store.submitRepair(
    B.hash,
    chunkEvery(makeData('not-B', B.data.length), 4096),
  );
  assert.equal(rejectedHash.status, 'rejected');
  // 未知哈希。
  const rejectedUnknown = await store.submitRepair(sha256Hex(makeData('zzz', 10)), [makeData('zzz', 10)]);
  assert.equal(rejectedUnknown.status, 'rejected');
  // 被拒绝的补传不改变块与报告。
  assert.equal(await store.getReport(), null);
  await assert.rejects(fs.stat(path.join(dir, 'blocks', B.hash)), /ENOENT/);

  // 完整校验。
  const report = await store.validate();
  assert.equal(report.corruptBlocks.length, 3);
  const byHash = new Map(report.corruptBlocks.map((e) => [e.hash, e]));
  // 重复引用不得重复计数：A 在 v1 出现两次，但受影响版本只列一次。
  assert.deepEqual(byHash.get(A.hash)!.affectedVersions, ['v1', 'v2']);
  assert.equal(byHash.get(A.hash)!.corruption, 'hash-mismatch');
  assert.deepEqual(byHash.get(B.hash)!.affectedVersions, ['v2', 'v3']);
  assert.equal(byHash.get(B.hash)!.corruption, 'missing');
  assert.deepEqual(byHash.get(D.hash)!.affectedVersions, ['v1']);
  assert.equal(byHash.get(D.hash)!.corruption, 'length-mismatch');
  assert.deepEqual(report.damagedVersions, ['v1', 'v2', 'v3']);

  // 修好 A：共享引用同时恢复，但 v1 还有 D、v2/v3 还有 B，全部仍在受损列表。
  const repairedA = await store.submitRepair(A.hash, chunkEvery(A.data, 7777));
  assert.equal(repairedA.status, 'repaired');
  let current = (await store.getReport())!;
  assert.deepEqual(current.corruptBlocks.map((e) => e.hash).sort(), [B.hash, D.hash].sort());
  assert.deepEqual(current.damagedVersions, ['v1', 'v2', 'v3']);
  const onDiskA = await fs.readFile(path.join(dir, 'blocks', A.hash));
  assert.equal(sha256Hex(onDiskA), A.hash);

  // 同一块的正确补传可以重复提交：结果一致，不增加副本，不改变报告。
  const again = await store.submitRepair(A.hash, A.data);
  assert.equal(again.status, 'repaired');
  assert.deepEqual((await store.getReport())!.corruptBlocks.length, 2);
  const blockFiles = (await fs.readdir(path.join(dir, 'blocks'))).filter((n) => !n.includes('.tmp-'));
  assert.equal(blockFiles.length, 3); // A、C、D（错误长度那份）

  // 修好 B：v2、v3 全部恢复，只剩 v1 因 D 受损。
  const repairedB = await store.submitRepair(B.hash, chunkEvery(B.data, 65_536));
  assert.equal(repairedB.status, 'repaired');
  current = (await store.getReport())!;
  assert.deepEqual(current.corruptBlocks.map((e) => e.hash), [D.hash]);
  assert.deepEqual(current.damagedVersions, ['v1']);

  // 修好 D：报告清空。
  const repairedD = await store.submitRepair(D.hash, D.data);
  assert.equal(repairedD.status, 'repaired');
  current = (await store.getReport())!;
  assert.deepEqual(current.corruptBlocks, []);
  assert.deepEqual(current.damagedVersions, []);

  // 按清单重组的内容与原始字节一致。
  const expectV1 = concatBytes([A.data, A.data, D.data]);
  const expectV2 = concatBytes([A.data, B.data]);
  const expectV3 = concatBytes([B.data, C.data]);
  assert.deepEqual(await reassembleVersion(dir, manifest, 'v1'), expectV1);
  assert.deepEqual(await reassembleVersion(dir, manifest, 'v2'), expectV2);
  assert.deepEqual(await reassembleVersion(dir, manifest, 'v3'), expectV3);

  await store.close();

  // 重新打开：报告保持，修复结果不回退。
  const reopened = await BackupRepairStore.open(dir);
  const persisted = (await reopened.getReport())!;
  assert.deepEqual(persisted.corruptBlocks, []);
  assert.deepEqual(persisted.damagedVersions, []);
  await reopened.close();
});

test('import can only happen once', async () => {
  const dir2 = await makeRepoDir();
  try {
    const store = await BackupRepairStore.open(dir2);
    await store.import(manifest, []);
    await assert.rejects(store.import(manifest, []), /already imported/);
    await store.close();
  } finally {
    await removeRepoDir(dir2);
  }
});
