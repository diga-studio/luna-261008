import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { crashPoint } from './crashpoint';
import {
  atomicWriteFile,
  fileExists,
  fsyncDir,
  readJsonFile,
  removeFileIfExists,
  tempPathFor,
} from './fsutil';
import { buildManifestIndex, type ManifestIndex } from './manifest';
import type {
  CorruptionReport,
  CorruptBlockEntry,
  CorruptionKind,
  InitialBlock,
  Manifest,
  RepairChunks,
  RepairResult,
} from './types';

const MANIFEST_FILE = 'manifest.json';
const REPORT_FILE = 'report.json';
const JOURNAL_FILE = 'repair.journal';
const BLOCKS_DIR = 'blocks';

interface RepairJournal {
  hash: string;
  expectedLength: number;
}

async function* toAsyncIterable(
  data: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (data instanceof Uint8Array) {
    yield data;
    return;
  }
  for await (const chunk of data as AsyncIterable<Uint8Array>) {
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  }
}

/**
 * 备份完整性修复库的主入口。所有操作串行执行。
 *
 * 仓库目录布局：
 *   manifest.json     固定版本清单（导入后不变）
 *   blocks/<hash>     块正文，按内容寻址
 *   report.json       当前损坏报告（仅完整校验结束时原子替换）
 *   repair.journal    修复意向日志（崩溃恢复用）
 *
 * 崩溃恢复不变式：被中断的修复只会收敛到两种状态——
 * 原块与原报告均未改变，或正确的新块已生效且对应损坏项已解除。
 */
export class BackupRepairStore {
  private readonly dir: string;
  private readonly blocksDir: string;
  private index: ManifestIndex | null = null;
  private report: CorruptionReport | null = null;
  private recoveryBytes = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(dir: string) {
    this.dir = dir;
    this.blocksDir = path.join(dir, BLOCKS_DIR);
  }

  /** 打开（或创建）仓库并自动执行崩溃恢复。 */
  static async open(dir: string): Promise<BackupRepairStore> {
    const store = new BackupRepairStore(dir);
    await fs.mkdir(store.blocksDir, { recursive: true });
    const manifest = await readJsonFile<Manifest>(path.join(dir, MANIFEST_FILE));
    if (manifest) store.index = buildManifestIndex(manifest);
    store.report = await readJsonFile<CorruptionReport>(path.join(dir, REPORT_FILE));
    await store.recoverInterruptedRepair();
    await store.cleanStaleTempFiles();
    return store;
  }

  /** 上次 open() 自动恢复期间读取的块正文字节数。 */
  get recoveryBytesRead(): number {
    return this.recoveryBytes;
  }

  /** 导入固定版本清单及初始块数据。每个仓库只能导入一次。 */
  async import(
    manifest: Manifest,
    blocks: Iterable<InitialBlock> | AsyncIterable<InitialBlock>,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.index) throw new Error('manifest already imported');
      const index = buildManifestIndex(manifest);
      for await (const block of blocks as AsyncIterable<InitialBlock>) {
        const entry = index.byHash.get(block.hash);
        if (!entry) throw new Error(`initial block ${block.hash} is not referenced by the manifest`);
        const finalPath = this.blockPath(block.hash);
        if (await fileExists(finalPath)) continue; // 相同哈希只有一份正文
        await this.writeBlockAtomic(finalPath, toAsyncIterable(block.data));
      }
      await atomicWriteFile(this.manifestPath(), Buffer.from(JSON.stringify(manifest), 'utf8'));
      this.index = index;
    });
  }

  /** 完整校验：检查所有被引用块的存在性、长度和 SHA-256。只有结束后才替换当前报告。 */
  async validate(): Promise<CorruptionReport> {
    return this.enqueue(async () => {
      const index = this.requireIndex();
      const corruptBlocks: CorruptBlockEntry[] = [];
      const damaged = new Set<string>();
      const hashes = [...index.byHash.keys()].sort();
      for (const hash of hashes) {
        const entry = index.byHash.get(hash)!;
        const corruption = await this.checkBlock(entry.hash, entry.length);
        if (corruption) {
          corruptBlocks.push({
            hash: entry.hash,
            expectedLength: entry.length,
            corruption,
            affectedVersions: [...entry.versions],
          });
          for (const v of entry.versions) damaged.add(v);
        }
      }
      const report: CorruptionReport = {
        generatedAt: new Date().toISOString(),
        corruptBlocks,
        damagedVersions: [...damaged].sort(),
      };
      crashPoint('validate:before-commit');
      await atomicWriteFile(this.reportPath(), Buffer.from(JSON.stringify(report), 'utf8'));
      this.report = report;
      return report;
    });
  }

  /**
   * 提交单块修复。收到完整数据并确认长度、SHA-256 都匹配清单之前，
   * 不替换原块、不解除损坏记录；被拒绝的补传不改变原有块和报告。
   */
  async submitRepair(hash: string, chunks: RepairChunks): Promise<RepairResult> {
    return this.enqueue(async () => {
      const index = this.requireIndex();
      const entry = index.byHash.get(hash);
      if (!entry) return { status: 'rejected', reason: 'unknown-hash' } as RepairResult;

      const journal: RepairJournal = { hash, expectedLength: entry.length };
      await atomicWriteFile(this.journalPath(), Buffer.from(JSON.stringify(journal), 'utf8'));
      crashPoint('repair:journal-written');

      const finalPath = this.blockPath(hash);
      const tmp = tempPathFor(finalPath);
      const hasher = createHash('sha256');
      let total = 0;
      let lengthExceeded = false;
      const handle = await fs.open(tmp, 'w');
      try {
        for await (const chunk of toAsyncIterable(chunks)) {
          if (chunk.length === 0) continue;
          total += chunk.length;
          if (total > entry.length) {
            lengthExceeded = true;
            break;
          }
          hasher.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }

      const verified =
        !lengthExceeded && total === entry.length && hasher.digest('hex') === hash;
      crashPoint('repair:data-verified');

      if (!verified) {
        await removeFileIfExists(tmp);
        await removeFileIfExists(this.journalPath());
        await fsyncDir(this.dir);
        return { status: 'rejected', reason: 'data-mismatch' };
      }

      await fs.rename(tmp, finalPath);
      await fsyncDir(this.blocksDir);
      crashPoint('repair:block-committed');

      if (this.report) {
        const updated = this.reportWithout(hash);
        await atomicWriteFile(this.reportPath(), Buffer.from(JSON.stringify(updated), 'utf8'));
        this.report = updated;
      }
      crashPoint('repair:report-committed');

      await removeFileIfExists(this.journalPath());
      await fsyncDir(this.dir);
      crashPoint('repair:journal-cleared');
      return { status: 'repaired' };
    });
  }

  /** 读取当前损坏报告；尚未完成过完整校验时返回 null。 */
  async getReport(): Promise<CorruptionReport | null> {
    return this.enqueue(async () =>
      this.report ? (JSON.parse(JSON.stringify(this.report)) as CorruptionReport) : null,
    );
  }

  /** 关闭仓库（等待进行中的操作结束）。 */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  // ---- 内部实现 ----

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('store is closed'));
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireIndex(): ManifestIndex {
    if (!this.index) throw new Error('manifest not imported yet');
    return this.index;
  }

  private manifestPath(): string {
    return path.join(this.dir, MANIFEST_FILE);
  }

  private reportPath(): string {
    return path.join(this.dir, REPORT_FILE);
  }

  private journalPath(): string {
    return path.join(this.dir, JOURNAL_FILE);
  }

  private blockPath(hash: string): string {
    return path.join(this.blocksDir, hash);
  }

  /** 把块数据流式写入临时文件，fsync 后原子 rename 到最终路径。 */
  private async writeBlockAtomic(
    finalPath: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const tmp = tempPathFor(finalPath);
    const handle = await fs.open(tmp, 'w');
    try {
      for await (const chunk of chunks) {
        if (chunk.length > 0) await handle.write(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, finalPath);
    await fsyncDir(this.blocksDir);
  }

  /** 检查单个块：存在性、长度、SHA-256。 */
  private async checkBlock(hash: string, expectedLength: number): Promise<CorruptionKind | null> {
    let size: number;
    try {
      size = (await fs.stat(this.blockPath(hash))).size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw err;
    }
    if (size !== expectedLength) return 'length-mismatch';
    const data = await fs.readFile(this.blockPath(hash));
    const actual = createHash('sha256').update(data).digest('hex');
    return actual === hash ? null : 'hash-mismatch';
  }

  /** 从报告中移除指定哈希的损坏项，并重新计算受损版本列表。 */
  private reportWithout(hash: string): CorruptionReport {
    const current = this.report;
    if (!current) throw new Error('no report');
    const corruptBlocks = current.corruptBlocks.filter((e) => e.hash !== hash);
    const damaged = new Set<string>();
    for (const e of corruptBlocks) for (const v of e.affectedVersions) damaged.add(v);
    return {
      generatedAt: current.generatedAt,
      corruptBlocks,
      damagedVersions: [...damaged].sort(),
    };
  }

  /**
   * 恢复被中断的修复。日志存在时：
   * - 块已是正确新数据（长度+哈希匹配）→ 提交：解除报告中的损坏项；
   * - 否则（rename 未发生，原块保持原样）→ 回滚：仅删除日志。
   * 两种情况下都不会留下半写块或只更新一侧的状态。
   * 单次恢复最多读取一个块的正文（≤ 4 MiB）。
   */
  private async recoverInterruptedRepair(): Promise<void> {
    const journal = await readJsonFile<RepairJournal>(this.journalPath());
    if (!journal) return;
    const entry = this.index ? this.index.byHash.get(journal.hash) : undefined;
    let blockIsCorrect = false;
    if (entry) {
      try {
        const stat = await fs.stat(this.blockPath(journal.hash));
        if (stat.size === entry.length) {
          const data = await fs.readFile(this.blockPath(journal.hash));
          this.recoveryBytes += data.length;
          blockIsCorrect = createHash('sha256').update(data).digest('hex') === journal.hash;
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (blockIsCorrect && this.report) {
      const updated = this.reportWithout(journal.hash);
      await atomicWriteFile(this.reportPath(), Buffer.from(JSON.stringify(updated), 'utf8'));
      this.report = updated;
    }
    await removeFileIfExists(this.journalPath());
    await fsyncDir(this.dir);
  }

  /** 清理中断操作留下的临时文件（半写块只可能以临时文件形式存在）。 */
  private async cleanStaleTempFiles(): Promise<void> {
    for (const dir of [this.dir, this.blocksDir]) {
      for (const name of await fs.readdir(dir)) {
        if (name.includes('.tmp-')) {
          await removeFileIfExists(path.join(dir, name));
        }
      }
    }
  }
}
