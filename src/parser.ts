import { DnsName, RecordType, Zone, ZoneParseError, ZoneRecord } from './types';
import { LogicalLine, tokenize } from './tokenizer';
import { nameInZone, nameKey, parseName } from './name';
import { parseRdata, rdataKey, SUPPORTED_TYPES } from './rdata';

const MIN_TTL = 300;
const MAX_TTL = 86400;

function parseTtl(raw: string, line: number): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new ZoneParseError(`TTL must be decimal seconds: ${raw}`, line);
  }
  const value = parseInt(raw, 10);
  if (value < MIN_TTL || value > MAX_TTL) {
    throw new ZoneParseError(`TTL out of range ${MIN_TTL}..${MAX_TTL}: ${raw}`, line);
  }
  return value;
}

class ZoneBuilder {
  private records: ZoneRecord[] = [];
  private ttlByOwnerType = new Map<string, number>();
  private seen = new Set<string>();
  private typesByOwner = new Map<string, Set<RecordType>>();
  private cnameKeyByOwner = new Map<string, string>();

  add(record: ZoneRecord, line: number): void {
    const ownerKey = nameKey(record.owner);
    const type = record.rdata.type;
    const groupKey = `${ownerKey}|${type}`;
    const dataKey = `${groupKey}|${rdataKey(record.rdata)}`;

    const knownTtl = this.ttlByOwnerType.get(groupKey);
    if (knownTtl !== undefined && knownTtl !== record.ttl) {
      throw new ZoneParseError(
        `conflicting TTLs ${knownTtl} and ${record.ttl} for same owner and type`,
        line,
      );
    }

    if (this.seen.has(dataKey)) return; // exact duplicate: merge

    let types = this.typesByOwner.get(ownerKey);
    if (type === 'CNAME') {
      if (types !== undefined && !types.has('CNAME')) {
        throw new ZoneParseError('CNAME cannot coexist with other types at same owner', line);
      }
      const existing = this.cnameKeyByOwner.get(ownerKey);
      if (existing !== undefined && existing !== rdataKey(record.rdata)) {
        throw new ZoneParseError('owner has more than one CNAME target', line);
      }
    } else if (types !== undefined && types.has('CNAME')) {
      throw new ZoneParseError('CNAME cannot coexist with other types at same owner', line);
    }

    this.seen.add(dataKey);
    this.ttlByOwnerType.set(groupKey, record.ttl);
    if (types === undefined) {
      types = new Set();
      this.typesByOwner.set(ownerKey, types);
    }
    types.add(type);
    if (type === 'CNAME') this.cnameKeyByOwner.set(ownerKey, rdataKey(record.rdata));
    this.records.push(record);
  }

  result(origin: DnsName): Zone {
    return { origin, records: this.records };
  }
}

/** Parse a zone file (ASCII text) into a normalized Zone. Throws ZoneParseError. */
export function parseZone(text: string, origin: string): Zone {
  const initialOrigin = parseName(origin, [], undefined);
  let currentOrigin = initialOrigin;
  let defaultTtl = MIN_TTL;
  let lastOwner: DnsName | undefined;
  const builder = new ZoneBuilder();

  for (const logical of tokenize(text)) {
    const first = logical.tokens[0]!;

    if (!first.quoted && first.raw.startsWith('$')) {
      const directive = first.raw.toUpperCase();
      if (directive === '$ORIGIN') {
        if (logical.tokens.length !== 2) {
          throw new ZoneParseError('$ORIGIN expects exactly one argument', logical.line);
        }
        const arg = logical.tokens[1]!;
        if (arg.quoted) throw new ZoneParseError('$ORIGIN name must not be quoted', arg.line);
        currentOrigin = parseName(arg.raw, currentOrigin, arg.line);
      } else if (directive === '$TTL') {
        if (logical.tokens.length !== 2) {
          throw new ZoneParseError('$TTL expects exactly one argument', logical.line);
        }
        const arg = logical.tokens[1]!;
        if (arg.quoted) throw new ZoneParseError('$TTL must not be quoted', arg.line);
        defaultTtl = parseTtl(arg.raw, arg.line);
      } else {
        throw new ZoneParseError(`unsupported directive ${first.raw}`, logical.line);
      }
      continue;
    }

    lastOwner = parseRecord(logical, currentOrigin, defaultTtl, initialOrigin, lastOwner, builder);
  }

  return builder.result(initialOrigin);
}

function parseRecord(
  logical: LogicalLine,
  currentOrigin: DnsName,
  defaultTtl: number,
  initialOrigin: DnsName,
  lastOwner: DnsName | undefined,
  builder: ZoneBuilder,
): DnsName {
  const tokens = logical.tokens;
  let idx = 0;
  let owner: DnsName;

  if (logical.startsWithWhitespace) {
    if (lastOwner === undefined) {
      throw new ZoneParseError('first record cannot omit owner', logical.line);
    }
    owner = lastOwner;
  } else {
    const ownerTok = tokens[0]!;
    if (ownerTok.quoted) {
      throw new ZoneParseError('owner name must not be quoted', ownerTok.line);
    }
    owner = parseName(ownerTok.raw, currentOrigin, ownerTok.line);
    idx = 1;
  }

  if (!nameInZone(owner, initialOrigin)) {
    throw new ZoneParseError('owner is outside the zone', logical.line);
  }

  let ttl: number | undefined;
  let seenIn = false;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (!tok.quoted && ttl === undefined && /^[0-9]+$/.test(tok.raw)) {
      ttl = parseTtl(tok.raw, tok.line);
      idx += 1;
    } else if (!tok.quoted && !seenIn && /^in$/i.test(tok.raw)) {
      seenIn = true;
      idx += 1;
    } else {
      break;
    }
  }

  if (idx >= tokens.length) {
    throw new ZoneParseError('missing record type', logical.line);
  }
  const typeTok = tokens[idx]!;
  if (typeTok.quoted) {
    throw new ZoneParseError('record type must not be quoted', typeTok.line);
  }
  const type = typeTok.raw.toUpperCase() as RecordType;
  if (!SUPPORTED_TYPES.includes(type)) {
    throw new ZoneParseError(`unsupported record type ${typeTok.raw}`, typeTok.line);
  }
  idx += 1;

  const rdata = parseRdata(type, tokens.slice(idx), currentOrigin, logical.line);
  builder.add({ owner, ttl: ttl ?? defaultTtl, rdata }, logical.line);
  return owner;
}
