import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BackupRepairStore, type CorruptionReport } from '../src/index.js';
import { makeRepoDir, removeRepoDir, sha256Hex } from './helpers.js';
import { X, Y, Z, M1, M2, M3, M4, corruptX, setupRepo } from './scenario.js';

const CHILD = path.join(__dirname, 'children', 'repair-child.js');
const MIB = 1024 * 1024;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(dir: string, action: string, crashAt?: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, REPO_DIR: dir, ACTION: action };
    if (crashAt) env.BACKUP_REPAIR_CRASH_AT = crashAt;
    else delete env.BACKUP_REPAIR_CRASH_AT;
    const child = spawn(process.execPath, [CHILD], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function corruptHashes(report: CorruptionReport): string[] {
  return report.corruptBlocks.map((e) => e.hash).sort();
}

const ALL_CORRUPT = [X.hash, Y.hash, M1.hash, M2.hash, M3.hash, M4.hash].sort();
const AFTER_X_FIXED = [Y.hash, M1.hash, M2.hash, M3.hash, M4.hash].sort();

async function listFiles(dir: string): Promise<string[]> {
  return fs.readdir(dir);
}

async function assertNoLeftovers(dir: string): Promise<void> {
  const rootFiles = await listFiles(dir);
  assert.ok(!rootFiles.includes('repair.journal'), 'journal must be gone');
  assert.ok(!rootFiles.some((f) => f.includes('.tmp-')), 'no temp files in repo root');
  const blockFiles = await listFiles(path.join(dir, 'blocks'));
  assert.ok(!blockFiles.some((f) => f.includes('.tmp-')), 'no temp files in blocks dir');
}

async function readBlock(dir: string, hash: string): Promise<Buffer> {
  return fs.readFile(path.join(dir, 'blocks', hash));
}

test('修复数据只写一部分就被杀：回滚到原状，重复补传后修复成功', async () => {
  const dir = await makeRepoDir();
  try {
    const initial = await setupRepo(dir);
    assert.deepEqual(corruptHashes(initial), ALL_CORRUPT);

    // 子进程在流式补传中途被 SIGKILL。
    const crashed = await runChild(dir, 'repair-partial');
    assert.equal(crashed.signal, 'SIGKILL');

    // 重新打开：自动回滚——原块与原报告均保持不变。
    const store = await BackupRepairStore.open(dir);
    assert.ok(store.recoveryBytesRead <= 16 * MIB, 'recovery read limit');
    const report = (await store.getReport())!;
    assert.deepEqual(corruptHashes(report), ALL_CORRUPT);
    assert.deepEqual(await readBlock(dir, X.hash), Buffer.from(corruptX));
    await assertNoLeftovers(dir);

    // 重复补传正确数据：修复成功，仅解除 X 的损坏记录。
    const result = await store.submitRepair(X.hash, X.data);
    assert.equal(result.status, 'repaired');
    const after = (await store.getReport())!;
    assert.deepEqual(corruptHashes(after), AFTER_X_FIXED);
    assert.deepEqual(after.damagedVersions, ['v1', 'v2']); // v1 还有 Y，v2 还有 M1..M4
    assert.equal(sha256Hex(await readBlock(dir, X.hash)), X.hash);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('块文件已替换、报告未更新时被杀：恢复为“新块生效且损坏项解除”', async () => {
  const dir = await makeRepoDir();
  try {
    await setupRepo(dir);
    const crashed = await runChild(dir, 'repair', 'repair:block-committed');
    assert.equal(crashed.signal, 'SIGKILL');

    const store = await BackupRepairStore.open(dir);
    // 只按日志恢复了 X 一个块：读取量 = 4 MiB，远低于 16 MiB 上限；
    // 若退化为重新完整校验，需读 X+M1..M4 共 20 MiB 以上。
    assert.equal(store.recoveryBytesRead, 4 * MIB);
    const report = (await store.getReport())!;
    assert.deepEqual(corruptHashes(report), AFTER_X_FIXED);
    assert.equal(sha256Hex(await readBlock(dir, X.hash)), X.hash);
    await assertNoLeftovers(dir);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('报告已更新、日志未删时被杀：恢复幂等提交，状态一致', async () => {
  const dir = await makeRepoDir();
  try {
    await setupRepo(dir);
    const crashed = await runChild(dir, 'repair', 'repair:report-committed');
    assert.equal(crashed.signal, 'SIGKILL');

    const store = await BackupRepairStore.open(dir);
    assert.equal(store.recoveryBytesRead, 4 * MIB);
    const report = (await store.getReport())!;
    assert.deepEqual(corruptHashes(report), AFTER_X_FIXED);
    assert.equal(sha256Hex(await readBlock(dir, X.hash)), X.hash);
    await assertNoLeftovers(dir);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('修复结果已落盘、即将返回成功时被杀：重启后不回退', async () => {
  const dir = await makeRepoDir();
  try {
    await setupRepo(dir);
    const crashed = await runChild(dir, 'repair', 'repair:journal-cleared');
    assert.equal(crashed.signal, 'SIGKILL');

    const store = await BackupRepairStore.open(dir);
    assert.equal(store.recoveryBytesRead, 0); // 日志已删，无需任何恢复读取
    const report = (await store.getReport())!;
    assert.deepEqual(corruptHashes(report), AFTER_X_FIXED);
    assert.equal(sha256Hex(await readBlock(dir, X.hash)), X.hash);
    await assertNoLeftovers(dir);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('已向调用方返回成功的修复，进程随后被杀：重启后不回退', async () => {
  const dir = await makeRepoDir();
  try {
    await setupRepo(dir);
    const crashed = await runChild(dir, 'repair-then-die');
    assert.equal(crashed.signal, 'SIGKILL');
    assert.ok(crashed.stdout.includes('REPAIR_RESULT repaired'), crashed.stdout);

    const store = await BackupRepairStore.open(dir);
    assert.equal(store.recoveryBytesRead, 0);
    const report = (await store.getReport())!;
    assert.deepEqual(corruptHashes(report), AFTER_X_FIXED);
    assert.equal(sha256Hex(await readBlock(dir, X.hash)), X.hash);
    await assertNoLeftovers(dir);
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('完整校验被中断：此前完整报告保持可用，不混入未完成结果', async () => {
  const dir = await makeRepoDir();
  try {
    await setupRepo(dir);
    // 先成功修复 X，使当前报告变为 AFTER_X_FIXED。
    const store = await BackupRepairStore.open(dir);
    const repaired = await store.submitRepair(X.hash, X.data);
    assert.equal(repaired.status, 'repaired');
    const before = (await store.getReport())!;
    assert.deepEqual(corruptHashes(before), AFTER_X_FIXED);
    await store.close();

    // 子进程开始完整校验，在替换报告前被杀。
    const crashed = await runChild(dir, 'validate', 'validate:before-commit');
    assert.equal(crashed.signal, 'SIGKILL');

    // 重新打开：报告与校验中断前完全一致。
    const reopened = await BackupRepairStore.open(dir);
    const after = (await reopened.getReport())!;
    assert.deepEqual(after, before);
    await assertNoLeftovers(dir);
    await reopened.close();
  } finally {
    await removeRepoDir(dir);
  }
});

test('健康块上的重复补传是幂等 no-op', async () => {
  const dir = await makeRepoDir();
  try {
    await setupRepo(dir);
    const store = await BackupRepairStore.open(dir);
    const before = (await store.getReport())!;
    // Z 是健康块，重复提交正确数据：成功、报告不变、不产生额外文件。
    const result = await store.submitRepair(Z.hash, Z.data);
    assert.equal(result.status, 'repaired');
    assert.deepEqual(await store.getReport(), before);
    const blockFiles = (await listFiles(path.join(dir, 'blocks'))).filter((f) => !f.includes('.tmp-'));
    assert.equal(blockFiles.length, 6); // X、Z、M1..M4
    await store.close();
  } finally {
    await removeRepoDir(dir);
  }
});
