const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

export function mail(lines: string[]): Uint8Array {
  return utf8(lines.join("\r\n"));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64_ALPHABET[a >> 2]!;
    out += B64_ALPHABET[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[c & 63]! : "=";
  }
  return out;
}

export function quotedPrintableEncode(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte >= 33 && byte <= 126 && byte !== 61) {
      out += String.fromCharCode(byte);
    } else {
      out += "=" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

export function assertTrue(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${message}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

export function assertSetEqual(actual: string[], expected: string[], message: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assertTrue(
    a.length === e.length && a.every((value, index) => value === e[index]),
    `${message}\n  expected set: ${JSON.stringify(e)}\n  actual set:   ${JSON.stringify(a)}`
  );
}

export function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`assertion failed: expected throw — ${message}`);
}
