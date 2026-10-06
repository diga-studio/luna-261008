import { formatName, nameKey } from './name';
import { rdataKey } from './parse';
import { RData, Zone, ZoneRecord } from './types';

function formatIPv4(address: Uint8Array): string {
  return Array.from(address, (b) => b.toString(10)).join('.');
}

function formatIPv6(address: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push((address[i * 2]! << 8) | address[i * 2 + 1]!);
  }
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && groups[i] === 0) {
      if (curStart < 0) {
        curStart = i;
        curLen = 0;
      }
      curLen += 1;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) {
    bestStart = -1;
  }
  const parts: string[] = [];
  let i = 0;
  while (i < 8) {
    if (i === bestStart) {
      parts.push('');
      i += bestLen;
      if (i === 8) {
        parts.push('');
      }
    } else {
      parts.push(groups[i]!.toString(16));
      i += 1;
    }
  }
  let out = parts.join(':');
  if (bestStart === 0) {
    out = `:${out}`;
  }
  return out;
}

function formatCharString(bytes: Uint8Array): string {
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22 || b === 0x5c) {
      out += `\\${String.fromCharCode(b)}`;
    } else if (b < 0x20 || b > 0x7e) {
      out += `\\${b.toString(10).padStart(3, '0')}`;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return `${out}"`;
}

function formatRData(rdata: RData, origin: Zone['origin']): string {
  switch (rdata.type) {
    case 'A':
      return formatIPv4(rdata.address);
    case 'AAAA':
      return formatIPv6(rdata.address);
    case 'CNAME':
      return formatName(rdata.target, origin);
    case 'MX':
      return `${rdata.preference} ${formatName(rdata.exchange, origin)}`;
    case 'TXT':
      return rdata.strings.map(formatCharString).join(' ');
    case 'SRV':
      return `${rdata.priority} ${rdata.weight} ${rdata.port} ${formatName(rdata.target, origin)}`;
  }
}

export function serializeZone(zone: Zone): string {
  const sorted: ZoneRecord[] = [...zone.records].sort((a, b) => {
    const byOwner = nameKey(a.owner).localeCompare(nameKey(b.owner));
    if (byOwner !== 0) {
      return byOwner;
    }
    if (a.rdata.type !== b.rdata.type) {
      return a.rdata.type < b.rdata.type ? -1 : 1;
    }
    return rdataKey(a.rdata).localeCompare(rdataKey(b.rdata));
  });
  const lines = sorted.map(
    (record) =>
      `${formatName(record.owner, zone.origin)} ${record.ttl} IN ${record.rdata.type} ${formatRData(record.rdata, zone.origin)}`,
  );
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
