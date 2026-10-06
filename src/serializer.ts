import { Zone, ZoneRecord } from './types';
import { compareNames, nameToString } from './name';
import { rdataKey, rdataToString, SUPPORTED_TYPES } from './rdata';

function typeRank(record: ZoneRecord): number {
  return SUPPORTED_TYPES.indexOf(record.rdata.type);
}

function compareRecords(a: ZoneRecord, b: ZoneRecord): number {
  const byOwner = compareNames(a.owner, b.owner);
  if (byOwner !== 0) return byOwner;
  const byType = typeRank(a) - typeRank(b);
  if (byType !== 0) return byType;
  const ka = rdataKey(a.rdata);
  const kb = rdataKey(b.rdata);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Serialize a zone to canonical presentation format. */
export function serializeZone(zone: Zone): string {
  const lines: string[] = [
    `$ORIGIN ${nameToString(zone.origin)}`,
    '$TTL 300',
  ];
  const records = zone.records.slice().sort(compareRecords);
  for (const record of records) {
    lines.push(
      `${nameToString(record.owner)} ${record.ttl} IN ${record.rdata.type} ${rdataToString(record.rdata)}`,
    );
  }
  return lines.join('\n') + '\n';
}
