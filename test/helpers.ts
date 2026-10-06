import { createScanner, type Rule, type ScanResult } from "../src/scanner.js";

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export interface RunOutcome {
  /** 各次 write() 返回的新命中，按顺序拼接。 */
  writeHits: string[];
  result: ScanResult;
}

/** 用给定的切块方式跑一遍扫描。 */
export function runScan(
  message: Uint8Array,
  rules: Rule[],
  chunks: Uint8Array[],
): RunOutcome {
  const scanner = createScanner(rules);
  const writeHits: string[] = [];
  for (const chunk of chunks) {
    writeHits.push(...scanner.write(chunk));
  }
  return { writeHits, result: scanner.finish() };
}

/** 整封一次喂入。 */
export function whole(message: Uint8Array): Uint8Array[] {
  return [message];
}

/** 在位置 k 切成两段。 */
export function splitAt(message: Uint8Array, k: number): Uint8Array[] {
  return [message.subarray(0, k), message.subarray(k)];
}

/** 单字节切块。 */
export function singleBytes(message: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < message.length; i++) {
    chunks.push(message.subarray(i, i + 1));
  }
  return chunks;
}

/** 固定大小的切块。 */
export function fixedChunks(message: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < message.length; i += size) {
    chunks.push(message.subarray(i, i + size));
  }
  return chunks;
}

/** base64 编码并按 76 列折行（CRLF）。 */
export function base64Lines(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/** quoted-printable 编码 UTF-8 文本（全部非 ASCII 转 =XX，可插入软换行）。 */
export function qpEncode(text: string, softBreakEvery = 0): string {
  const raw = encoder.encode(text);
  let out = "";
  let col = 0;
  for (const b of raw) {
    let token: string;
    if ((b >= 33 && b <= 60) || (b >= 62 && b <= 126)) {
      token = String.fromCharCode(b);
    } else {
      token = "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
    out += token;
    col += token.length;
    if (softBreakEvery > 0 && col >= softBreakEvery) {
      out += "=\r\n";
      col = 0;
    }
  }
  return out;
}
