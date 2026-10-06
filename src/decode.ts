/** 流式传输解码器：输入编码字节，输出解码后的字节。 */
export interface TransferDecoder {
  /** 喂入字节，返回本次可确定的解码输出。 */
  push(bytes: Uint8Array): Uint8Array;
  /** 结束输入，返回剩余输出；非法收尾（如 base64 长度不足）抛错。 */
  end(): Uint8Array;
}

/** 流式字符集解码器：输入字节，输出字符。 */
export interface CharsetDecoder {
  push(bytes: Uint8Array): string;
  end(): string;
}

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const TAB = 0x09;

function isWs(b: number): boolean {
  return b === CR || b === LF || b === SP || b === TAB;
}

class IdentityDecoder implements TransferDecoder {
  push(bytes: Uint8Array): Uint8Array {
    return bytes;
  }
  end(): Uint8Array {
    return new Uint8Array(0);
  }
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();
const B64_PAD = 0x3d; // '='

class Base64Decoder implements TransferDecoder {
  private pending: number[] = [];
  private padded = false;

  push(bytes: Uint8Array): Uint8Array {
    const out: number[] = [];
    for (const b of bytes) {
      if (isWs(b)) {
        continue;
      }
      if (this.padded) {
        throw new Error("base64 data after padding");
      }
      this.pending.push(b);
      if (this.pending.length === 4) {
        this.flushQuartet(this.pending, out);
        this.pending = [];
      }
    }
    return Uint8Array.from(out);
  }

  private flushQuartet(quartet: number[], out: number[]): void {
    const values: number[] = [];
    let pads = 0;
    for (const b of quartet) {
      if (b === B64_PAD) {
        pads += 1;
        values.push(0);
      } else {
        if (pads > 0) {
          throw new Error("base64 padding in the middle of a quartet");
        }
        if (b >= 128 || B64_TABLE[b]! < 0) {
          throw new Error(`invalid base64 character 0x${b.toString(16)}`);
        }
        values.push(B64_TABLE[b]!);
      }
    }
    if (pads > 2) {
      throw new Error("too much base64 padding");
    }
    if (pads > 0) {
      this.padded = true;
    }
    const triple = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    out.push((triple >> 16) & 0xff);
    if (pads < 2) {
      out.push((triple >> 8) & 0xff);
    }
    if (pads < 1) {
      out.push(triple & 0xff);
    }
  }

  end(): Uint8Array {
    if (this.pending.length !== 0) {
      throw new Error("truncated base64 data");
    }
    return new Uint8Array(0);
  }
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

class QuotedPrintableDecoder implements TransferDecoder {
  /** 未决的 '=' 序列（1~2 字节）。 */
  private pending: number[] = [];

  push(bytes: Uint8Array): Uint8Array {
    const out: number[] = [];
    let i = 0;
    // 先消化上一块遗留的 '=' 序列。
    while (this.pending.length > 0 && i < bytes.length && this.pending.length < 3) {
      this.pending.push(bytes[i]!);
      i += 1;
      if (this.tryFlushPending(out)) {
        // 已完整处理。
      }
    }
    if (this.pending.length > 0 && this.pending.length >= 3) {
      this.tryFlushPending(out);
    }
    for (; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b === 0x3d) {
        // '='：需要后续字节才能判定，缓存。
        this.pending = [b];
        // 尝试立即吸收后续字节。
        if (i + 1 < bytes.length) {
          this.pending.push(bytes[i + 1]!);
          i += 1;
          if (i + 1 < bytes.length) {
            this.pending.push(bytes[i + 1]!);
            i += 1;
          }
        }
        this.tryFlushPending(out);
        if (this.pending.length > 0) {
          // 剩余字节留待下一块。
        }
      } else {
        out.push(b);
      }
    }
    return Uint8Array.from(out);
  }

  /** 若 pending 已可判定则处理并清空，返回是否已清空。 */
  private tryFlushPending(out: number[]): boolean {
    const p = this.pending;
    if (p.length === 0) {
      return true;
    }
    // p[0] 必为 '='。
    if (p.length >= 2) {
      // 软换行：=CRLF 或 =LF。
      if (p[1] === LF) {
        this.pending = [];
        return true;
      }
      if (p[1] === CR) {
        if (p.length === 3) {
          if (p[2] === LF) {
            this.pending = [];
            return true;
          }
          throw new Error("invalid quoted-printable soft break");
        }
        return false; // 等待 LF。
      }
      const hi = hexValue(p[1]!);
      if (hi < 0) {
        throw new Error("invalid quoted-printable escape");
      }
      if (p.length === 3) {
        const lo = hexValue(p[2]!);
        if (lo < 0) {
          throw new Error("invalid quoted-printable escape");
        }
        out.push((hi << 4) | lo);
        this.pending = [];
        return true;
      }
      return false; // 等待低位十六进制。
    }
    return false;
  }

  end(): Uint8Array {
    // 合法内容里 '=' 不会悬在末尾；宽松处理：裸 '=' 按原样输出。
    if (this.pending.length === 1) {
      const out = Uint8Array.from(this.pending);
      this.pending = [];
      return out;
    }
    if (this.pending.length > 1) {
      throw new Error("truncated quoted-printable escape");
    }
    return new Uint8Array(0);
  }
}

/** 创建传输解码器，encoding 为小写名称：7bit/8bit/base64/quoted-printable。 */
export function createTransferDecoder(encoding: string): TransferDecoder {
  switch (encoding) {
    case "7bit":
    case "8bit":
      return new IdentityDecoder();
    case "base64":
      return new Base64Decoder();
    case "quoted-printable":
      return new QuotedPrintableDecoder();
    default:
      throw new Error(`unsupported content-transfer-encoding: ${encoding}`);
  }
}

const ASCII_BLOCK = 8192;

class AsciiCharsetDecoder implements CharsetDecoder {
  push(bytes: Uint8Array): string {
    const parts: string[] = [];
    for (let start = 0; start < bytes.length; start += ASCII_BLOCK) {
      const block = bytes.subarray(start, start + ASCII_BLOCK);
      const codes: number[] = new Array(block.length);
      for (let i = 0; i < block.length; i++) {
        codes[i] = block[i]! & 0x7f;
      }
      parts.push(String.fromCharCode(...codes));
    }
    return parts.join("");
  }
  end(): string {
    return "";
  }
}

class Utf8CharsetDecoder implements CharsetDecoder {
  private readonly decoder = new TextDecoder("utf-8");

  push(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }
  end(): string {
    return this.decoder.decode();
  }
}

/** 创建字符集解码器，charset 为小写名称：us-ascii/utf-8。 */
export function createCharsetDecoder(charset: string): CharsetDecoder {
  switch (charset) {
    case "us-ascii":
    case "ascii":
      return new AsciiCharsetDecoder();
    case "utf-8":
    case "utf8":
      return new Utf8CharsetDecoder();
    default:
      throw new Error(`unsupported charset: ${charset}`);
  }
}
