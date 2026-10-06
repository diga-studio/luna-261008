function encodeLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function derTLV(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

export function derSequence(...parts: Buffer[]): Buffer {
  return derTLV(0x30, Buffer.concat(parts));
}

export function derSet(...parts: Buffer[]): Buffer {
  return derTLV(0x31, Buffer.concat(parts));
}

export function derInteger(value: Buffer): Buffer {
  let bytes = value;
  while (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) === 0) {
    bytes = bytes.subarray(1);
  }
  if (bytes.length === 0) {
    bytes = Buffer.from([0]);
  }
  if ((bytes[0] & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return derTLV(0x02, bytes);
}

export function derIntegerFromNumber(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid integer for DER encoding: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return derInteger(Buffer.from(bytes));
}

export function derOid(oid: string): Buffer {
  const arcs = oid.split(".").map((part) => {
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`invalid OID arc: ${oid}`);
    }
    return n;
  });
  if (arcs.length < 2 || arcs[0] > 2 || arcs[1] > 39) {
    throw new Error(`invalid OID: ${oid}`);
  }
  const out: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack: number[] = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      stack.unshift(0x80 | (remaining & 0x7f));
      remaining = Math.floor(remaining / 128);
    }
    out.push(...stack);
  }
  return derTLV(0x06, Buffer.from(out));
}

export function derUtcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return derTLV(0x17, Buffer.from(text, "ascii"));
}

export function derBitString(value: Buffer): Buffer {
  return derTLV(0x03, Buffer.concat([Buffer.from([0x00]), value]));
}

export function derOctetString(value: Buffer): Buffer {
  return derTLV(0x04, value);
}

export function derExplicit(tagNumber: number, value: Buffer): Buffer {
  return derTLV(0xa0 + tagNumber, value);
}

export interface DerNode {
  readonly tag: number;
  readonly headerLength: number;
  readonly length: number;
  readonly totalLength: number;
  readonly value: Buffer;
  readonly full: Buffer;
}

export function readTlv(buf: Buffer, offset = 0): DerNode {
  if (offset + 2 > buf.length) {
    throw new Error("truncated DER: missing tag or length");
  }
  const tag = buf[offset];
  const firstLen = buf[offset + 1];
  let length: number;
  let headerLength: number;
  if ((firstLen & 0x80) === 0) {
    length = firstLen;
    headerLength = 2;
  } else {
    const numBytes = firstLen & 0x7f;
    if (numBytes === 0 || numBytes > 4 || offset + 2 + numBytes > buf.length) {
      throw new Error("unsupported DER length encoding");
    }
    length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = length * 256 + buf[offset + 2 + i];
    }
    headerLength = 2 + numBytes;
  }
  if (offset + headerLength + length > buf.length) {
    throw new Error("truncated DER: value exceeds buffer");
  }
  return {
    tag,
    headerLength,
    length,
    totalLength: headerLength + length,
    value: buf.subarray(offset + headerLength, offset + headerLength + length),
    full: buf.subarray(offset, offset + headerLength + length),
  };
}

export function readChildren(node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = 0;
  while (offset < node.value.length) {
    const child = readTlv(node.value, offset);
    children.push(child);
    offset += child.totalLength;
  }
  return children;
}
