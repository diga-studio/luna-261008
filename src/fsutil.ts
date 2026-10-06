import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** 确保目录存在（递归创建）。 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 判断路径是否存在。 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 删除文件（不存在时忽略）。 */
export async function removeIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** 对目录执行 fsync，保证目录项（rename 结果）持久。 */
export async function fsyncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 原子写文件：先写同目录临时文件并 fsync，再 rename 覆盖目标，最后 fsync 目录。
 * 进程在任意一步被杀，目标文件要么是旧内容，要么是完整新内容。
 */
export async function writeFileAtomic(p: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${p}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, p);
  await fsyncDir(path.dirname(p));
}

/** 清理目录下残留的临时文件（以 .tmp 结尾）；目录不存在时忽略。 */
export async function cleanTmpFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (name.endsWith(".tmp")) {
      await removeIfExists(path.join(dir, name));
    }
  }
}

/**
 * 流式计算文件的 SHA-256 与长度；文件不存在时返回 null。
 * onBytes 回调用于统计正文读取量。
 */
export async function hashFile(
  p: string,
  onBytes?: (n: number) => void,
): Promise<{ hex: string; size: number } | null> {
  const hash = createHash("sha256");
  let size = 0;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(p, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
      onBytes?.(bytesRead);
    }
  } finally {
    await handle.close();
  }
  return { hex: hash.digest("hex"), size };
}
