/** A domain name as an array of labels; each label preserves case and arbitrary octets. Root = []. */
export type DomainName = Uint8Array[];

export interface Header {
  id: number;
  flags: number;
  qdCount: number;
  anCount: number;
  nsCount: number;
  arCount: number;
}

export interface Question {
  name: DomainName;
  qtype: number;
  qclass: number;
}

export interface CNameRData {
  kind: "cname";
  name: DomainName;
}

export interface SoaRData {
  kind: "soa";
  mname: DomainName;
  rname: DomainName;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

export interface RawRData {
  kind: "raw";
  data: Uint8Array;
}

export type RData = CNameRData | SoaRData | RawRData;

export interface ResourceRecord {
  name: DomainName;
  type: number;
  rrClass: number;
  ttl: number;
  rdata: RData;
}

export interface Message {
  header: Header;
  questions: Question[];
  answers: ResourceRecord[];
  authorities: ResourceRecord[];
  additionals: ResourceRecord[];
}

export class DnsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsParseError";
  }
}
