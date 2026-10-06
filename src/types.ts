/**
 * A domain name is a sequence of labels; each label is raw bytes (1..63).
 * The root name is an empty label list. Names are compared case-insensitively
 * for ASCII letters only, byte-exact otherwise.
 */
export type DnsName = ReadonlyArray<Uint8Array>;

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV';

export interface ARecord { type: 'A'; address: Uint8Array }        // 4 bytes
export interface AAAARecord { type: 'AAAA'; address: Uint8Array }  // 16 bytes
export interface CnameRecord { type: 'CNAME'; target: DnsName }
export interface MxRecord { type: 'MX'; preference: number; exchange: DnsName }
export interface TxtRecord { type: 'TXT'; segments: ReadonlyArray<Uint8Array> }
export interface SrvRecord {
  type: 'SRV';
  priority: number;
  weight: number;
  port: number;
  target: DnsName;
}

export type Rdata =
  | ARecord
  | AAAARecord
  | CnameRecord
  | MxRecord
  | TxtRecord
  | SrvRecord;

export interface ZoneRecord {
  owner: DnsName; // always absolute
  ttl: number;    // seconds, 300..86400
  rdata: Rdata;
}

export interface Zone {
  /** Initial $ORIGIN (absolute), canonical form. */
  origin: DnsName;
  records: ZoneRecord[];
}

export class ZoneParseError extends Error {
  constructor(message: string, public readonly line?: number) {
    super(line !== undefined ? `line ${line}: ${message}` : message);
    this.name = 'ZoneParseError';
  }
}
