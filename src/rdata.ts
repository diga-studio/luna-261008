import { DnsName, Rdata, RecordType, ZoneParseError } from './types';
import { Token } from './tokenizer';
import { nameKey, nameToString, parseName } from './name';

export const SUPPORTED_TYPES: ReadonlyArray<RecordType> = [
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV',
];

function fail(message: string, line?: number): never {
  throw new ZoneParseError(message, line);
}

function parseUint16(raw: string, what: string, line?: number): number {
  if (!/^[0-9]+$/.test(raw)) fail(`${what} must be decimal digits: ${raw}`, line);
  const value = parseInt(raw, 10);
  if (value > 65535) fail(`${what} out of range 0..65535: ${raw}`, line);
  return value;
}

export function parseIPv4(raw: string, line?: number): Uint8Array {
  const parts = raw.split('.');
  if (parts.length !== 4) fail(`invalid IPv4 address: ${raw}`, line);
  const bytes = parts.map((p) => {
    if (!/^[0-9]{1,3}$/.test(p)) fail(`invalid IPv4 address: ${raw}`, line);
    const v = parseInt(p, 10);
    if (v > 255) fail(`invalid IPv4 address: ${raw}`, line);
    return v;
  });
  return Uint8Array.from(bytes);
}

function isHexGroup(s: string): boolean {
  return /^[0-9a-fA-F]{1,4}$/.test(s);
}

export function parseIPv6(raw: string, line?: number): Uint8Array {
  const out = new Uint8Array(16);
  const dcIdx = raw.indexOf('::');
  if (dcIdx !== raw.lastIndexOf('::')) fail(`invalid IPv6 address: ${raw}`, line);
  const hasCompress = dcIdx !== -1;
  const left = hasCompress ? raw.slice(0, dcIdx) : raw;
  const right = hasCompress ? raw.slice(dcIdx + 2) : '';

  const parseSide = (side: string): number[] => {
    if (side === '') return [];
    const groups = side.split(':');
    const words: number[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]!;
      if (g === '') fail(`invalid IPv6 address: ${raw}`, line);
      if (g.includes('.')) {
        if (gi !== groups.length - 1) fail(`invalid IPv6 address: ${raw}`, line);
        const v4 = parseIPv4(g, line);
        words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!isHexGroup(g)) fail(`invalid IPv6 address: ${raw}`, line);
        words.push(parseInt(g, 16));
      }
    }
    return words;
  };

  const lw = parseSide(left);
  const rw = parseSide(right);
  let words: number[];
  if (hasCompress) {
    const fill = 8 - lw.length - rw.length;
    if (fill < 1) fail(`invalid IPv6 address: ${raw}`, line);
    words = [...lw, ...new Array<number>(fill).fill(0), ...rw];
  } else {
    if (lw.length !== 8) fail(`invalid IPv6 address: ${raw}`, line);
    words = lw;
  }
  if (words.length !== 8) fail(`invalid IPv6 address: ${raw}`, line);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = words[i]! >> 8;
    out[i * 2 + 1] = words[i]! & 0xff;
  }
  return out;
}

export function ipv6ToString(bytes: Uint8Array): string {
  const words: number[] = [];
  for (let i = 0; i < 8; i++) words.push((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  // find longest run of zero words (length >= 2), first wins on tie
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && words[i] === 0) {
      if (curStart === -1) curStart = i;
    } else {
      if (curStart !== -1) {
        const len = i - curStart;
        if (len >= 2 && len > bestLen) {
          bestStart = curStart;
          bestLen = len;
        }
        curStart = -1;
      }
    }
  }
  const hex = words.map((w) => w.toString(16));
  if (bestStart === -1) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

function expectNameToken(tok: Token | undefined, origin: DnsName, line?: number): DnsName {
  if (!tok) fail('missing name', line);
  if (tok.quoted) fail('name must not be quoted', tok.line);
  return parseName(tok.raw, origin, tok.line);
}

function expectCount(tokens: Token[], n: number, type: string, line?: number): void {
  if (tokens.length !== n) {
    fail(`${type} expects ${n} field(s), got ${tokens.length}`, line);
  }
}

export function parseRdata(
  type: RecordType,
  tokens: Token[],
  origin: DnsName,
  line?: number,
): Rdata {
  switch (type) {
    case 'A': {
      expectCount(tokens, 1, 'A', line);
      const tok = tokens[0]!;
      if (tok.quoted) fail('A address must not be quoted', tok.line);
      return { type: 'A', address: parseIPv4(tok.raw, tok.line) };
    }
    case 'AAAA': {
      expectCount(tokens, 1, 'AAAA', line);
      const tok = tokens[0]!;
      if (tok.quoted) fail('AAAA address must not be quoted', tok.line);
      return { type: 'AAAA', address: parseIPv6(tok.raw, tok.line) };
    }
    case 'CNAME': {
      expectCount(tokens, 1, 'CNAME', line);
      return { type: 'CNAME', target: expectNameToken(tokens[0], origin, line) };
    }
    case 'MX': {
      expectCount(tokens, 2, 'MX', line);
      const pref = tokens[0]!;
      if (pref.quoted) fail('MX preference must not be quoted', pref.line);
      return {
        type: 'MX',
        preference: parseUint16(pref.raw, 'MX preference', pref.line),
        exchange: expectNameToken(tokens[1], origin, line),
      };
    }
    case 'TXT': {
      if (tokens.length < 1) fail('TXT expects at least one segment', line);
      const segments = tokens.map((t) => {
        if (t.bytes.length > 255) {
          fail(`TXT segment exceeds 255 bytes (${t.bytes.length})`, t.line);
        }
        return t.bytes;
      });
      return { type: 'TXT', segments };
    }
    case 'SRV': {
      expectCount(tokens, 4, 'SRV', line);
      const [p, w, port] = tokens;
      if (p!.quoted || w!.quoted || port!.quoted) {
        fail('SRV numeric fields must not be quoted', line);
      }
      return {
        type: 'SRV',
        priority: parseUint16(p!.raw, 'SRV priority', p!.line),
        weight: parseUint16(w!.raw, 'SRV weight', w!.line),
        port: parseUint16(port!.raw, 'SRV port', port!.line),
        target: expectNameToken(tokens[3], origin, line),
      };
    }
  }
}

function txtSegmentToString(segment: Uint8Array): string {
  let out = '"';
  for (const b of segment) {
    if (b === 0x22 || b === 0x5c) {
      out += '\\' + String.fromCharCode(b);
    } else if (b >= 0x20 && b <= 0x7e) {
      out += String.fromCharCode(b);
    } else {
      out += '\\' + b.toString().padStart(3, '0');
    }
  }
  return out + '"';
}

export function rdataToString(rdata: Rdata): string {
  switch (rdata.type) {
    case 'A':
      return Array.from(rdata.address).join('.');
    case 'AAAA':
      return ipv6ToString(rdata.address);
    case 'CNAME':
      return nameToString(rdata.target);
    case 'MX':
      return `${rdata.preference} ${nameToString(rdata.exchange)}`;
    case 'TXT':
      return rdata.segments.map(txtSegmentToString).join(' ');
    case 'SRV':
      return `${rdata.priority} ${rdata.weight} ${rdata.port} ${nameToString(rdata.target)}`;
  }
}

function bytesKey(bytes: Uint8Array): string {
  return Array.from(bytes).join(',');
}

/** Canonical byte key used for duplicate detection and equality. */
export function rdataKey(rdata: Rdata): string {
  switch (rdata.type) {
    case 'A':
    case 'AAAA':
      return `${rdata.type}|${bytesKey(rdata.address)}`;
    case 'CNAME':
      return `CNAME|${nameKey(rdata.target)}`;
    case 'MX':
      return `MX|${rdata.preference}|${nameKey(rdata.exchange)}`;
    case 'TXT':
      return `TXT|${rdata.segments.map(bytesKey).join('|')}`;
    case 'SRV':
      return `SRV|${rdata.priority}|${rdata.weight}|${rdata.port}|${nameKey(rdata.target)}`;
  }
}
