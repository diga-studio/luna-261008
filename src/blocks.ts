import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { cleanTmpFiles, ensureDir, fsyncDir, hashFile, pathExists, removeIfExists } from "./fsutil.js";

const BLOCKS_DIR = "blocks";
const STAGING_DIR = "staging";

function assertValidHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`非法块哈希：${hash}`);
  }
}

/**
 * 块正文存储：blocks/<前2位十六进制>/<完整哈希>。
 * 块文件只通过“暂存 + fsync + 原子 rename”提交，绝不原地改写。
 */
export class BlockStore {
  private readonly dir: string;
  private readonly onBytesRead?: ((n: number) => void) | undefined;

  constructor(dir: string, onBytesRead?: (n: number) => void) {
    this.dir = dir;
    this.onBytesRead = onBytesRead;
  }

  private get blocksDir(): string {
    return path.join(this.dir, BLOCKS_DIR);
  }

  private get stagingDir(): string {
    return path.join(this.dir, STAGING_DIR);
  }

  /** 块文件的最终路径。 */
  blockPath(hash: string): string {
    assertValidHash(hash);
    return path.join(this.blocksDir, hash.slice(0, 2), hash);
  }

  private stagingPath(hash: string): string {
    assertValidHash(hash);
    return path.join(this.stagingDir, `${hash}.tmp`);
  }

  /**
   * 把逐段到达的字节写入暂存文件，返回实际字节数与 SHA-256。
   * 调用方负责比对清单；比对失败应调用 discardStaging。
   */
  async stage(
    hash: string,
    chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<{ size: number; hex: string }> {
    await ensureDir(this.stagingDir);
    const tmp = this.stagingPath(hash);
    const digest = createHash("sha256");
    let size = 0;
    const handle = await fs.open(tmp, "w");
    try {
      for await (const chunk of chunks) {
        if (chunk.length === 0) continue;
        await handle.write(chunk);
        digest.update(chunk);
        size += chunk.length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { size, hex: digest.digest("hex") };
  }

  /** 丢弃暂存文件（补传被拒绝或中断时）。 */
  async discardStaging(hash: string): Promise<void> {
    await removeIfExists(this.stagingPath(hash));
  }

  /** 把暂存文件原子提交为正式块文件（fsync 文件与目录）。 */
  async commitStaged(hash: string): Promise<void> {
    const tmp = this.stagingPath(hash);
    const target = this.blockPath(hash);
    await ensureDir(path.dirname(target));
    await fs.rename(tmp, target);
    await fsyncDir(path.dirname(target));
  }

  /** 校验块文件：存在、长度与 SHA-256 均匹配才返回 true。 */
  async verifyBlock(hash: string, expectedLength: number): Promise<boolean> {
    const result = await hashFile(this.blockPath(hash), this.onBytesRead);
    if (result === null) return false;
    return result.size === expectedLength && result.hex === hash;
  }

  /** 清理所有遗留暂存文件。 */
  async cleanStaging(): Promise<void> {
    await cleanTmpFiles(this.stagingDir);
  }

  /** 供恢复逻辑判断块文件是否已经是期望内容。 */
  async blockMatches(hash: string, expectedLength: number): Promise<boolean> {
    if (!(await pathExists(this.blockPath(hash)))) return false;
    return this.verifyBlock(hash, expectedLength);
  }
}
