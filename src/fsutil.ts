import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** 生成同目录下的临时文件名。 */
export function tempPathFor(finalPath: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${finalPath}.tmp-${process.pid}-${rand}`;
}

/** 对文件路径做 fsync（打开后 sync 再关闭）。 */
async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 对目录做 fsync，保证其内 rename 结果落盘。 */
export async function fsyncDir(dirPath: string): Promise<void> {
  const handle = await fs.open(dirPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 把数据原子写入 path：写同目录临时文件、fsync、rename、目录 fsync。
 * 崩溃时只会留下临时文件，目标文件要么是旧内容要么是新内容。
 */
export async function atomicWriteFile(finalPath: string, data: Uint8Array): Promise<void> {
  const tmp = tempPathFor(finalPath);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, finalPath);
  await fsyncDir(path.dirname(finalPath));
}

/** 读取 JSON 文件；不存在时返回 null。 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}

/** 文件是否存在。 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** 删除文件；不存在时忽略。 */
export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
