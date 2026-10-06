import { inflateRawSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** Creates a temp directory populated with the given relative-path files. */
export function makeSourceDir(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "scorm-src-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  }
  return dir;
}

/** Minimal ZIP reader: returns entry name -> uncompressed content. */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  // Locate the End Of Central Directory record.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip file");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central header");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    // Read the local header to find the data start.
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    entries.set(name, data);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
