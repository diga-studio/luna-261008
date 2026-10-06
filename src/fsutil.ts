import { createHash } from "node:crypto";
import { open, readFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Compute the lowercase hex SHA-256 of a file's exact bytes. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** Compute the lowercase hex SHA-256 of an in-memory buffer. */
export function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Write data to path atomically: write a temp file in the same directory,
 * fsync it, then rename over the target. The target never observes a
 * partially written file.
 */
export async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/** Read an entire file into a Buffer. */
export async function readFileBuffer(path: string): Promise<Buffer> {
  return readFile(path);
}
