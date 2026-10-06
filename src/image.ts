import * as fs from "fs";
import { RecoveryError } from "./errors.js";

/**
 * Random-access reader over a raw/dd image file. Offsets are absolute byte
 * positions inside the image and may exceed 4 GiB (safe up to 2^53).
 */
export class ImageReader {
  private readonly fd: number;
  private readonly fileSize: number;

  private constructor(fd: number, fileSize: number) {
    this.fd = fd;
    this.fileSize = fileSize;
  }

  static open(imagePath: string): ImageReader {
    let fd: number;
    try {
      fd = fs.openSync(imagePath, "r");
    } catch (err) {
      throw new RecoveryError("IO", `cannot open image ${imagePath}: ${String(err)}`);
    }
    const size = fs.fstatSync(fd).size;
    return new ImageReader(fd, size);
  }

  get size(): number {
    return this.fileSize;
  }

  /** Read exactly `length` bytes starting at absolute image offset `offset`. */
  readAt(offset: number, length: number): Buffer {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new RecoveryError("OUT_OF_BOUNDS", `invalid read at ${offset} length ${length}`);
    }
    const buf = Buffer.alloc(length);
    this.readInto(buf, 0, offset, length);
    return buf;
  }

  /** Read exactly `length` bytes at absolute image offset `offset` into `buf` at `bufOffset`. */
  readInto(buf: Buffer, bufOffset: number, offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new RecoveryError("OUT_OF_BOUNDS", `invalid read at ${offset} length ${length}`);
    }
    if (offset + length > this.fileSize) {
      throw new RecoveryError("OUT_OF_BOUNDS", `read past end of image at ${offset} length ${length}`);
    }
    if (bufOffset < 0 || bufOffset + length > buf.length) {
      throw new RecoveryError("OUT_OF_BOUNDS", "target buffer too small");
    }
    let done = 0;
    while (done < length) {
      const n = fs.readSync(this.fd, buf, bufOffset + done, length - done, offset + done);
      if (n <= 0) {
        throw new RecoveryError("IO", `short read at ${offset + done}`);
      }
      done += n;
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}
