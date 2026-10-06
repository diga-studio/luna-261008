import { promises as fs } from "node:fs";
import * as path from "node:path";
import { cleanTmpFiles, ensureDir, pathExists, writeFileAtomic } from "./fsutil.js";
import { EMPTY_REPORT, type CorruptionEntry, type CorruptionReport } from "./types.js";

const REPORT_FILE = "report.json";

function normalize(report: CorruptionReport): CorruptionReport {
  const entries = [...report.entries].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const damaged = new Set<string>();
  for (const e of entries) {
    for (const v of e.versions) damaged.add(v);
  }
  return {
    generatedAt: report.generatedAt,
    entries,
    damagedVersions: [...damaged].sort(),
  };
}

/**
 * 损坏报告存储：report.json，整体原子替换。
 * 中断的校验/修复不会暴露半份报告（临时文件残留会在加载前清理）。
 */
export class ReportStore {
  private readonly filePath: string;
  private report: CorruptionReport;

  private constructor(filePath: string, report: CorruptionReport) {
    this.filePath = filePath;
    this.report = report;
  }

  /** 加载当前报告；不存在时返回空报告。 */
  static async load(dir: string): Promise<ReportStore> {
    await ensureDir(dir);
    // 清理上次原子替换被中断留下的临时文件，正式报告不受影响。
    await cleanTmpFiles(dir);
    const filePath = path.join(dir, REPORT_FILE);
    if (!(await pathExists(filePath))) {
      return new ReportStore(filePath, EMPTY_REPORT);
    }
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as CorruptionReport;
    return new ReportStore(filePath, normalize(parsed));
  }

  /** 当前报告（内存副本）。 */
  current(): CorruptionReport {
    return this.report;
  }

  /** 原子替换整份报告并 fsync。 */
  async save(report: CorruptionReport): Promise<void> {
    const normalized = normalize(report);
    await writeFileAtomic(this.filePath, JSON.stringify(normalized, null, 2));
    this.report = normalized;
  }

  /**
   * 从报告中解除一组哈希的损坏记录，并原子保存。
   * 返回是否有记录被移除。
   */
  async removeHashes(hashes: readonly string[]): Promise<boolean> {
    const drop = new Set(hashes);
    const kept = this.report.entries.filter((e) => !drop.has(e.hash));
    if (kept.length === this.report.entries.length) return false;
    const entries: CorruptionEntry[] = kept;
    await this.save({
      generatedAt: this.report.generatedAt,
      entries,
      damagedVersions: [],
    });
    return true;
  }
}
