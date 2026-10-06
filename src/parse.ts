import { inZone, nameKey, parseAbsoluteName, resolveName } from './name';
import { Token, TokenKind, tokenize } from './tokenizer';
import { RData, RecordType, Zone, ZoneError, ZoneName, ZoneRecord } from './types';

const MIN_TTL = 300;
const MAX_TTL = 86400;

const SUPPORTED_TYPES: readonly RecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV'];

function tokenText(token: Token): string {
  let out = '';
  for (const b of token.bytes) {
    out += String.fromCharCode(b);
  }
  return out;
}

function parseTtl(text: string, line: number): number {
  if (!/^[0-9]+$/.test(text)) {
    throw new ZoneError(`invalid TTL "${text}"`, line);
  }
  const value = Number(text);
  if (value < MIN_TTL || value > MAX_TTL) {
    throw new ZoneError(`TTL ${value} out of range ${MIN_TTL}..${MAX_TTL}`, line);
  }
  return value;
}

function parseUint16(text: string, what: string, line: number): number {
  if (!/^[0-9]+$/.test(text)) {
    throw new ZoneError(`invalid ${what} "${text}"`, line);
  }
  const value = Number(text);
  if (value > 65535) {
    throw new ZoneError(`${what} ${value} out of range 0..65535`, line);
  }
  return value;
}

function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const p = parts[i]!;
    if (!/^[0-9]{1,3}$/.test(p)) {
      return null;
    }
    const v = Number(p);
    if (v > 255) {
      return null;
    }
    out[i] = v;
  }
  return out;
}

function parseIPv6(text: string): Uint8Array | null {
  const parseSide = (side: string): number[] | null => {
    if (side === '') {
      return [];
    }
    const groups = side.split(':');
    const nums: number[] = [];
    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi]!;
      if (g === '') {
        return null;
      }
      if (g.includes('.')) {
        if (gi !== groups.length - 1) {
          return null;
        }
        const v4 = parseIPv4(g);
        if (v4 === null) {
          return null;
        }
        nums.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
          return null;
        }
        nums.push(parseInt(g, 16));
      }
    }
    return nums;
  };

  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  let groups: number[];
  if (halves.length === 1) {
    const only = parseSide(halves[0]!);
    if (only === null || only.length !== 8) {
      return null;
    }
    groups = only;
  } else {
    const left = parseSide(halves[0]!);
    const right = parseSide(halves[1]!);
    if (left === null || right === null) {
      return null;
    }
    const fill = 8 - left.length - right.length;
    if (fill < 1) {
      return null;
    }
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    out[i * 2] = groups[i]! >> 8;
    out[i * 2 + 1] = groups[i]! & 0xff;
  }
  return out;
}

function parseRData(
  type: RecordType,
  tokens: Token[],
  currentOrigin: ZoneName,
  line: number,
): RData {
  const need = (n: number): void => {
    if (tokens.length !== n) {
      throw new ZoneError(`${type} expects ${n} rdata field(s), got ${tokens.length}`, line);
    }
  };
  const nameAt = (t: Token): ZoneName => resolveName(t.bytes, t.escaped, currentOrigin, t.line);

  switch (type) {
    case 'A': {
      need(1);
      const address = parseIPv4(tokenText(tokens[0]!));
      if (address === null) {
        throw new ZoneError('invalid IPv4 address', tokens[0]!.line);
      }
      return { type, address };
    }
    case 'AAAA': {
      need(1);
      const address = parseIPv6(tokenText(tokens[0]!));
      if (address === null) {
        throw new ZoneError('invalid IPv6 address', tokens[0]!.line);
      }
      return { type, address };
    }
    case 'CNAME': {
      need(1);
      return { type, target: nameAt(tokens[0]!) };
    }
    case 'MX': {
      need(2);
      return {
        type,
        preference: parseUint16(tokenText(tokens[0]!), 'MX preference', tokens[0]!.line),
        exchange: nameAt(tokens[1]!),
      };
    }
    case 'TXT': {
      if (tokens.length < 1) {
        throw new ZoneError('TXT expects at least one character-string', line);
      }
      const strings = tokens.map((t) => {
        if (t.bytes.length > 255) {
          throw new ZoneError('TXT segment exceeds 255 bytes', t.line);
        }
        return Uint8Array.from(t.bytes);
      });
      return { type, strings };
    }
    case 'SRV': {
      need(4);
      return {
        type,
        priority: parseUint16(tokenText(tokens[0]!), 'SRV priority', tokens[0]!.line),
        weight: parseUint16(tokenText(tokens[1]!), 'SRV weight', tokens[1]!.line),
        port: parseUint16(tokenText(tokens[2]!), 'SRV port', tokens[2]!.line),
        target: nameAt(tokens[3]!),
      };
    }
  }
}

export function rdataKey(rdata: RData): string {
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  switch (rdata.type) {
    case 'A':
    case 'AAAA':
      return hex(rdata.address);
    case 'CNAME':
      return nameKey(rdata.target);
    case 'MX':
      return `${rdata.preference} ${nameKey(rdata.exchange)}`;
    case 'TXT':
      return rdata.strings.map((s) => `${s.length}:${hex(s)}`).join(' ');
    case 'SRV':
      return `${rdata.priority} ${rdata.weight} ${rdata.port} ${nameKey(rdata.target)}`;
  }
}

export function parseZone(text: string, origin: string): Zone {
  const initialOrigin = parseAbsoluteName(origin);
  let currentOrigin = initialOrigin;
  let defaultTtl = MIN_TTL;
  let lastOwner: ZoneName | null = null;
  const records: ZoneRecord[] = [];

  const tokens = tokenize(text);
  let i = 0;
  while (tokens[i]!.kind !== TokenKind.EOF) {
    if (tokens[i]!.kind === TokenKind.Newline) {
      i += 1;
      continue;
    }
    const entry: Token[] = [];
    while (tokens[i]!.kind !== TokenKind.Newline && tokens[i]!.kind !== TokenKind.EOF) {
      entry.push(tokens[i]!);
      i += 1;
    }

    const first = entry[0]!;
    if (first.kind === TokenKind.Word && first.bytes[0] === 0x24 && first.escaped[0] === 0) {
      const directive = tokenText(first).toUpperCase();
      if (directive === '$ORIGIN') {
        if (entry.length !== 2) {
          throw new ZoneError('$ORIGIN expects exactly one argument', first.line);
        }
        const arg = entry[1]!;
        currentOrigin = resolveName(arg.bytes, arg.escaped, currentOrigin, arg.line);
      } else if (directive === '$TTL') {
        if (entry.length !== 2) {
          throw new ZoneError('$TTL expects exactly one argument', first.line);
        }
        defaultTtl = parseTtl(tokenText(entry[1]!), entry[1]!.line);
      } else {
        throw new ZoneError(`unsupported directive ${tokenText(first)}`, first.line);
      }
      continue;
    }

    let idx = 0;
    let owner: ZoneName;
    if (!first.leadingBlank) {
      owner = resolveName(first.bytes, first.escaped, currentOrigin, first.line);
      lastOwner = owner;
      idx = 1;
    } else {
      if (lastOwner === null) {
        throw new ZoneError('first record may not omit the owner', first.line);
      }
      owner = lastOwner;
    }

    let ttl: number | null = null;
    let seenClass = false;
    while (idx < entry.length) {
      const t = entry[idx]!;
      const s = tokenText(t);
      if (ttl === null && /^[0-9]+$/.test(s)) {
        ttl = parseTtl(s, t.line);
        idx += 1;
        continue;
      }
      if (!seenClass && s.toUpperCase() === 'IN') {
        seenClass = true;
        idx += 1;
        continue;
      }
      break;
    }
    if (idx >= entry.length) {
      throw new ZoneError('missing record type', first.line);
    }
    const typeToken = entry[idx]!;
    const typeName = tokenText(typeToken).toUpperCase();
    if (!SUPPORTED_TYPES.includes(typeName as RecordType)) {
      throw new ZoneError(`unsupported record type "${tokenText(typeToken)}"`, typeToken.line);
    }
    const rdata = parseRData(typeName as RecordType, entry.slice(idx + 1), currentOrigin, first.line);

    if (!inZone(owner, initialOrigin)) {
      throw new ZoneError('owner is outside the zone', first.line);
    }
    records.push({ owner, ttl: ttl ?? defaultTtl, rdata });
  }

  // Same owner+type must share one TTL; merge exact duplicates.
  const ttlByGroup = new Map<string, number>();
  const seen = new Set<string>();
  const deduped: ZoneRecord[] = [];
  for (const record of records) {
    const groupKey = `${nameKey(record.owner)} ${record.rdata.type}`;
    const existingTtl = ttlByGroup.get(groupKey);
    if (existingTtl !== undefined && existingTtl !== record.ttl) {
      throw new ZoneError(`records for ${record.rdata.type} under one owner must share a TTL`);
    }
    ttlByGroup.set(groupKey, record.ttl);
    const fullKey = `${groupKey} ${record.ttl} ${rdataKey(record.rdata)}`;
    if (!seen.has(fullKey)) {
      seen.add(fullKey);
      deduped.push(record);
    }
  }

  // CNAME exclusivity: at most one target, and no other types at the owner.
  const typesByOwner = new Map<string, Set<string>>();
  const cnameCount = new Map<string, number>();
  for (const record of deduped) {
    const ownerKey = nameKey(record.owner);
    const types = typesByOwner.get(ownerKey) ?? new Set<string>();
    types.add(record.rdata.type);
    typesByOwner.set(ownerKey, types);
    if (record.rdata.type === 'CNAME') {
      cnameCount.set(ownerKey, (cnameCount.get(ownerKey) ?? 0) + 1);
    }
  }
  for (const [ownerKey, types] of typesByOwner) {
    if (!types.has('CNAME')) {
      continue;
    }
    if ((cnameCount.get(ownerKey) ?? 0) > 1) {
      throw new ZoneError('an owner may have at most one CNAME target');
    }
    if (types.size > 1) {
      throw new ZoneError('CNAME may not coexist with other record types at the same owner');
    }
  }

  return { origin: initialOrigin, records: deduped };
}
