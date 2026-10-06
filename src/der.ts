/**
 * Minimal DER (ASN.1 Distinguished Encoding Rules) writer and reader,
 * covering only what X.509 CRL generation and certificate parsing need.
 */

/** Encode a DER length. */
export function derLength(length: number): Buffer {
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

/** Encode a TLV (tag, length, value) triplet. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** SEQUENCE */
export function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

/** SEQUENCE OF */
export function sequenceOf(parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

/** INTEGER from a big-endian unsigned magnitude (leading zero added as needed). */
export function integerFromBytes(magnitude: Buffer): Buffer {
  let bytes = magnitude;
  while (bytes.length > 1 && bytes[0] === 0x00 && bytes[1] < 0x80) {
    bytes = bytes.subarray(1);
  }
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return tlv(0x02, bytes);
}

/** INTEGER from a non-negative JS number. */
export function integerFromNumber(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid INTEGER value: ${value}`);
  }
  if (value === 0) {
    return tlv(0x02, Buffer.from([0x00]));
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return integerFromBytes(Buffer.from(bytes));
}

/** OBJECT IDENTIFIER from dotted string, e.g. "1.2.840.113549.1.1.11". */
export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((part) => {
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`invalid OID arc in ${dotted}`);
    }
    return n;
  });
  if (arcs.length < 2 || arcs[0] > 2 || arcs[1] > 39) {
    throw new Error(`invalid OID: ${dotted}`);
  }
  const body: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const encoded: number[] = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      encoded.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    body.push(...encoded);
  }
  return tlv(0x06, Buffer.from(body));
}

/** NULL */
export function nullValue(): Buffer {
  return tlv(0x05, Buffer.alloc(0));
}

/** UTCTime (YYMMDDHHMMSSZ). Years 1950-2049 only, per RFC 5280. */
export function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) {
    throw new Error(`UTCTime cannot represent year ${year}`);
  }
  const text =
    pad(year % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

/** BIT STRING wrapping the given bytes with 0 unused bits. */
export function bitString(bytes: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
}

/** OCTET STRING */
export function octetString(bytes: Buffer): Buffer {
  return tlv(0x04, bytes);
}

/** [0] EXPLICIT wrapper (context-specific, constructed, tag 0). */
export function explicit0(content: Buffer): Buffer {
  return tlv(0xa0, content);
}

/** One parsed TLV element. */
export interface DerElement {
  readonly tag: number;
  /** Content bytes (without tag/length). */
  readonly content: Buffer;
  /** Full TLV bytes including tag and length. */
  readonly raw: Buffer;
  /** Offset just past this element. */
  readonly next: number;
}

/** Read one DER element from buf at offset. */
export function readElement(buf: Buffer, offset = 0): DerElement {
  if (offset >= buf.length) {
    throw new Error("DER: unexpected end of input");
  }
  const tag = buf[offset];
  let pos = offset + 1;
  const first = buf[pos++];
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4) {
      throw new Error("DER: unsupported length form");
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + buf[pos++];
    }
  }
  const end = pos + length;
  if (end > buf.length) {
    throw new Error("DER: truncated content");
  }
  return {
    tag,
    content: buf.subarray(pos, end),
    raw: buf.subarray(offset, end),
    next: end,
  };
}

/** Iterate over the child elements of a constructed element's content. */
export function children(element: DerElement): DerElement[] {
  const result: DerElement[] = [];
  let offset = 0;
  while (offset < element.content.length) {
    const child = readElement(element.content, offset);
    result.push(child);
    offset = child.next;
  }
  return result;
}

/** Decode a PEM block to DER bytes, verifying the expected label. */
export function pemToDer(pem: string, label: string): Buffer {
  const match = pem.match(
    new RegExp(
      `-----BEGIN ${label}-----([A-Za-z0-9+/=\\r\\n]+)-----END ${label}-----`,
    ),
  );
  if (!match) {
    throw new Error(`invalid PEM: expected ${label}`);
  }
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

/** Encode DER bytes as a PEM block with the given label. */
export function derToPem(der: Buffer, label: string): string {
  const base64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
