export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV';

/**
 * Absolute domain name as a list of labels. Each label is raw bytes
 * (length 1..63). The root name is an empty label list.
 */
export interface ZoneName {
  readonly labels: readonly Uint8Array[];
}

export type RData =
  | { readonly type: 'A'; readonly address: Uint8Array }
  | { readonly type: 'AAAA'; readonly address: Uint8Array }
  | { readonly type: 'CNAME'; readonly target: ZoneName }
  | { readonly type: 'MX'; readonly preference: number; readonly exchange: ZoneName }
  | { readonly type: 'TXT'; readonly strings: readonly Uint8Array[] }
  | {
      readonly type: 'SRV';
      readonly priority: number;
      readonly weight: number;
      readonly port: number;
      readonly target: ZoneName;
    };

export interface ZoneRecord {
  readonly owner: ZoneName;
  readonly ttl: number;
  readonly rdata: RData;
}

export interface Zone {
  readonly origin: ZoneName;
  readonly records: readonly ZoneRecord[];
}

export class ZoneError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line !== undefined ? `line ${line}: ${message}` : message);
    this.name = 'ZoneError';
  }
}
