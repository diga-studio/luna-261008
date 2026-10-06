import { promises as fs } from "node:fs";
import * as path from "node:path";
import { BlockStore } from "./blocks.js";
import { cleanTmpFiles, ensureDir, pathExists, removeIfExists, writeFileAtomic } from "./fsutil.js";
import { ManifestStore } from "./manifest.js";
import { ReportStore } from "./report.js";
import {
  EMPTY_REPORT,
  RepairRejectedError,
  type BlockInput,
  type CorruptionEntry,
  type CorruptionReport,
  type OpenOptions,
  type ReadStats,
  type RepairHooks,
  type RepairResult,
  type VerifyHooks,
  type VersionEntry,
} from "./types.js";

const JOURNAL_DIR = "journal";

interface JournalRecord {
  hash: string;
  length: number;
}

/**
 * 备份完整性修复库的主入口。所有操作在库内部串行执行。
 *
 * 修复的崩溃一致性靠修复日志（journal）保证：
 *   1. 补传数据写入暂存文件并校验长度与 SHA-256（失败则丢弃，状态不变）；
 *   2. 写 journal（fsync）后才允许提交块文件；
 *   3. 块文件经原子 rename 提交；
 *   4. 报告原子替换，解除该块的损坏记录；
 *   5. 删除 journal。
 * 重新打开时若发现 journal：块已是正确内容则补齐报告更新（步骤 4），
 * 否则说明崩溃发生在块提交之前，丢弃暂存、保持原块与原报告。
 */
export class BackupRepairStore {
  private readonly dir: string;
  private readonly blocks: BlockStore;
  private readonly reports: ReportStore;
  private readonly repairHooks: RepairHooks;
  private readonly verifyHooks: VerifyHooks;
  private readonly stats: ReadStats;
  /** 本次打开时自动恢复阶段读取的块正文字节数。 */
  readonly recoveryBlockBytesRead: number = 0;
  private manifest: ManifestStore | null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    dir: string,
    manifest: ManifestStore | null,
    reports: ReportStore,
    blocks: BlockStore,
    stats: ReadStats,
    options?: OpenOptions,
  ) {
    this.dir = dir;
    this.manifest = manifest;
    this.reports = reports;
    this.blocks = blocks;
    this.stats = stats;
    this.repairHooks = options?.repairHooks ?? {};
    this.verifyHooks = options?.verifyHooks ?? {};
  }

  /**
   * 打开（或创建）仓库并自动恢复。
   * 恢复只读取清单、报告、修复日志，以及至多一个被中断修复涉及的块正文。
   */
  static async open(dir: string, options?: OpenOptions): Promise<BackupRepairStore> {
    await ensureDir(dir);
    const stats: ReadStats = { blockBytesRead: 0 };
    const blocks = new BlockStore(dir, (n) => {
      stats.blockBytesRead += n;
    });
    // 清理被中断的暂存与报告临时文件；正式文件均经原子 rename，不受影响。
    await blocks.cleanStaging();
    const reports = await ReportStore.load(dir);
    const manifest = await ManifestStore.load(dir);
    const store = new BackupRepairStore(dir, manifest, reports, blocks, stats, options);
    // 恢复被中断的修复；此阶段的正文读取量单独记账。
    await store.recoverJournals();
    (store as { recoveryBlockBytesRead: number }).recoveryBlockBytesRead =
      stats.blockBytesRead;
    return store;
  }

  private get journalDir(): string {
    return path.join(this.dir, JOURNAL_DIR);
  }

  private journalPath(hash: string): string {
    return path.join(this.journalDir, `${hash}.json`);
  }

  private async recoverJournals(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.journalDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(
        await fs.readFile(path.join(this.journalDir, name), "utf8"),
      ) as JournalRecord;
      // 操作串行执行，至多一个修复在途；恢复读取的正文不超过一个块（4 MiB）。
      if (await this.blocks.blockMatches(record.hash, record.length)) {
        // 块已提交但报告可能未更新：补齐解除损坏记录的一侧。
        await this.reports.removeHashes([record.hash]);
      } else {
        // 崩溃发生在块提交之前：原块与原报告均未变，丢弃暂存即可。
        await this.blocks.discardStaging(record.hash);
      }
      await removeIfExists(this.journalPath(record.hash));
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireManifest(): ManifestStore {
    if (this.manifest === null) {
      throw new Error("仓库尚未导入清单");
    }
    return this.manifest;
  }

  /**
   * 导入固定版本清单与初始块数据。仅用于准备数据：
   * 仓库已有清单时抛出错误；初始块数据允许缺失或损坏，由后续校验发现。
   */
  async import(
    versions: readonly VersionEntry[],
    blocks: Iterable<BlockInput> | AsyncIterable<BlockInput>,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.manifest !== null || (await ManifestStore.load(this.dir)) !== null) {
        throw new Error("清单已存在：导入只允许一次，之后不增删版本");
      }
      const seen = new Set<string>();
      for await (const input of blocks) {
        if (seen.has(input.hash)) continue;
        seen.add(input.hash);
        if (await pathExists(this.blocks.blockPath(input.hash))) continue;
        await this.blocks.stage(input.hash, [input.data]);
        await this.blocks.commitStaged(input.hash);
      }
      await ManifestStore.writeAtomic(this.dir, versions);
      this.manifest = await ManifestStore.load(this.dir);
    });
  }

  /**
   * 完整校验：检查所有被引用块的存在性、长度与 SHA-256。
   * 只有校验全部结束才原子替换当前报告；中断不会暴露半份报告。
   */
  async verify(): Promise<CorruptionReport> {
    return this.enqueue(async () => {
      const manifest = this.requireManifest();
      // 汇总每个哈希被哪些版本引用（同一版本重复引用只计一次）。
      const referrers = new Map<string, Set<string>>();
      for await (const version of manifest.streamVersions()) {
        const seenInVersion = new Set<string>();
        for (const ref of version.blocks) {
          if (seenInVersion.has(ref.hash)) continue;
          seenInVersion.add(ref.hash);
          let set = referrers.get(ref.hash);
          if (set === undefined) {
            set = new Set<string>();
            referrers.set(ref.hash, set);
          }
          set.add(version.id);
        }
      }
      const entries: CorruptionEntry[] = [];
      for (const [hash, versions] of referrers) {
        const expected = manifest.expectedLength(hash);
        if (expected === undefined) continue; // 不可能发生：索引来自同一清单
        if (!(await this.blocks.verifyBlock(hash, expected))) {
          entries.push({
            hash,
            length: expected,
            versions: [...versions].sort(),
          });
        }
      }
      this.verifyHooks.beforeReportSave?.();
      const report: CorruptionReport = {
        generatedAt: new Date().toISOString(),
        entries,
        damagedVersions: [],
      };
      await this.reports.save(report);
      return this.reports.current();
    });
  }

  /**
   * 提交单块修复：收到完整数据并确认长度、SHA-256 匹配清单后，
   * 才原子替换块文件并解除对应损坏记录。被拒绝的补传不改变任何状态。
   */
  async repairBlock(
    hash: string,
    chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<RepairResult> {
    return this.enqueue(async () => {
      const manifest = this.requireManifest();
      const expected = manifest.expectedLength(hash);
      if (expected === undefined) {
        throw new RepairRejectedError("unknown-hash", `块 ${hash} 未被清单引用`);
      }
      const staged = await this.blocks.stage(hash, chunks);
      if (staged.size !== expected) {
        await this.blocks.discardStaging(hash);
        throw new RepairRejectedError(
          "length-mismatch",
          `块 ${hash} 长度不符：期望 ${expected}，实收 ${staged.size}`,
        );
      }
      if (staged.hex !== hash) {
        await this.blocks.discardStaging(hash);
        throw new RepairRejectedError("hash-mismatch", `块 ${hash} 的 SHA-256 与清单不符`);
      }
      const hadCorruptionRecord = this.reports
        .current()
        .entries.some((e) => e.hash === hash);
      // 先落 journal，再提交块，再更新报告，最后删 journal。
      await ensureDir(this.journalDir);
      await writeFileAtomic(
        this.journalPath(hash),
        JSON.stringify({ hash, length: expected } satisfies JournalRecord),
      );
      this.repairHooks.afterJournalWrite?.();
      await this.blocks.commitStaged(hash);
      this.repairHooks.afterBlockCommit?.();
      await this.reports.removeHashes([hash]);
      this.repairHooks.afterReportSave?.();
      await removeIfExists(this.journalPath(hash));
      return { hash, blockRewritten: hadCorruptionRecord };
    });
  }

  /** 块正文文件在仓库中的路径（供上层按清单重组内容）。 */
  blockPath(hash: string): string {
    return this.blocks.blockPath(hash);
  }

  /** 读取当前损坏报告。 */
  async getReport(): Promise<CorruptionReport> {
    return this.enqueue(async () => {
      if (this.manifest === null) return EMPTY_REPORT;
      return this.reports.current();
    });
  }

  /** 正文读取统计（验证恢复读取量上限）。 */
  get readStats(): ReadStats {
    return { blockBytesRead: this.stats.blockBytesRead };
  }

  /** 关闭仓库（等待队列中的操作完成）。 */
  async close(): Promise<void> {
    await this.queue;
  }
}
