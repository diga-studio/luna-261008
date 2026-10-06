import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

/**
 * 镜像只读随机访问读取器。
 * 偏移与长度使用 number：2 TiB 远小于 2^53，整数精确无误差。
 */
export class ImageReader {
  private constructor(private readonly handle: FileHandle) {}

  static async open(imagePath: string): Promise<ImageReader> {
    const handle = await open(imagePath, "r");
    return new ImageReader(handle);
  }

  async stat(): Promise<Stats> {
    return this.handle.stat();
  }

  /**
   * 在绝对偏移处读取恰好 length 字节，写入 buf 起始处。
   * 读不足（镜像截断）视为输入损坏，抛错。
   */
  async readAt(offset: number, length: number, buf: Buffer): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(`invalid read offset: ${offset}`);
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > buf.length) {
      throw new RangeError(`invalid read length: ${length}`);
    }
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(
        buf,
        filled,
        length - filled,
        offset + filled,
      );
      if (bytesRead === 0) {
        throw new Error(
          `short read at offset ${offset + filled}: image truncated`,
        );
      }
      filled += bytesRead;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
