import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { ensureDir, pathExists, writeFileAtomic } from "./fsutil.js";
import type { VersionEntry } from "./types.js";

const MANIFEST_FILE = "manifest.jsonl";

interface ManifestLine {
  id: string;
  blocks: [string, number][];
}

function serializeVersion(v: VersionEntry): string {
  const line: ManifestLine = {
    id: v.id,
    blocks: v.blocks.map((b) => [b.hash, b.length]),
  };
  return JSON.stringify(line);
}

function parseVersion(line: string): VersionEntry {
  const parsed = JSON.parse(line) as ManifestLine;
  return {
    id: parsed.id,
    blocks: parsed.blocks.map(([hash, length]) => ({ hash, length })),
  };
}

/**
 * 版本清单存储：manifest.jsonl，每行一个版本。
 * 清单可信，导入后不再增删版本。
 * 内存中只保留 哈希 -> 期望长度 的索引；校验时按行流式读取。
 */
export class ManifestStore {
  private readonly filePath: string;
  private readonly lengths = new Map<string, number>();

  private constructor(filePath: string, lengths: Map<string, number>) {
    this.filePath = filePath;
    this.lengths = lengths;
  }

  /** 打开已有清单；不存在时返回 null。加载哈希 -> 期望长度索引。 */
  static async load(dir: string): Promise<ManifestStore | null> {
    const filePath = path.join(dir, MANIFEST_FILE);
    if (!(await pathExists(filePath))) return null;
    const lengths = new Map<string, number>();
    const stream = await fs.open(filePath, "r");
    try {
      const rl = readline.createInterface({ input: stream.createReadStream() });
      for await (const line of rl) {
        if (line.trim() === "") continue;
        const v = parseVersion(line);
        for (const b of v.blocks) {
          const prev = lengths.get(b.hash);
          if (prev !== undefined && prev !== b.length) {
            throw new Error(`清单内部矛盾：块 ${b.hash} 的长度不一致`);
          }
          lengths.set(b.hash, b.length);
        }
      }
    } finally {
      await stream.close();
    }
    return new ManifestStore(filePath, lengths);
  }

  /** 原子写入清单（仅导入时调用一次）。 */
  static async writeAtomic(dir: string, versions: readonly VersionEntry[]): Promise<void> {
    await ensureDir(dir);
    const filePath = path.join(dir, MANIFEST_FILE);
    const body = versions.map(serializeVersion).join("\n") + "\n";
    await writeFileAtomic(filePath, body);
  }

  /** 查询某哈希在清单中的期望长度；未被引用时返回 undefined。 */
  expectedLength(hash: string): number | undefined {
    return this.lengths.get(hash);
  }

  /** 清单中引用的唯一块哈希数量。 */
  get uniqueBlockCount(): number {
    return this.lengths.size;
  }

  /** 流式遍历所有版本（完整校验用，避免一次性载入全部引用）。 */
  async *streamVersions(): AsyncIterable<VersionEntry> {
    const stream = await fs.open(this.filePath, "r");
    try {
      const rl = readline.createInterface({ input: stream.createReadStream() });
      for await (const line of rl) {
        if (line.trim() === "") continue;
        yield parseVersion(line);
      }
    } finally {
      await stream.close();
    }
  }
}
