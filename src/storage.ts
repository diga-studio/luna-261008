import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface FileStore {
  put(fileKey: string, source: AsyncIterable<Uint8Array>): Promise<void>;
  openRead(fileKey: string): Readable;
  delete(fileKey: string): Promise<void>;
}

let tmpCounter = 0;

export class LocalFileStore implements FileStore {
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }

  async put(fileKey: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const finalPath = path.join(this.directory, fileKey);
    const tmpPath = path.join(
      this.directory,
      `.tmp-${process.pid}-${tmpCounter++}`,
    );
    try {
      await pipeline(
        NodeReadable.from(source),
        fs.createWriteStream(tmpPath, { flags: "wx" }),
      );
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
    try {
      await fsp.rename(tmpPath, finalPath);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  openRead(fileKey: string): Readable {
    return fs.createReadStream(path.join(this.directory, fileKey));
  }

  async delete(fileKey: string): Promise<void> {
    await fsp.unlink(path.join(this.directory, fileKey)).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== "ENOENT") throw err;
    });
  }
}
