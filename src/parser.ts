import { NameTargetRegistry, readName } from "./name.js";
import {
  DnsParseError,
  type Header,
  type Message,
  type Question,
  type RData,
  type ResourceRecord,
} from "./types.js";

const HEADER_LENGTH = 12;
const TYPE_CNAME = 5;
const TYPE_SOA = 6;

class Reader {
  pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u16(context: string): number {
    if (this.pos + 2 > this.bytes.length) {
      throw new DnsParseError(`truncated ${context} at offset ${this.pos}`);
    }
    const value = (this.bytes[this.pos]! << 8) | this.bytes[this.pos + 1]!;
    this.pos += 2;
    return value;
  }

  u32(context: string): number {
    if (this.pos + 4 > this.bytes.length) {
      throw new DnsParseError(`truncated ${context} at offset ${this.pos}`);
    }
    const value =
      this.bytes[this.pos]! * 0x1000000 +
      ((this.bytes[this.pos + 1]! << 16) | (this.bytes[this.pos + 2]! << 8) | this.bytes[this.pos + 3]!);
    this.pos += 4;
    return value;
  }

  slice(length: number, context: string): Uint8Array {
    if (this.pos + length > this.bytes.length) {
      throw new DnsParseError(`truncated ${context} at offset ${this.pos}`);
    }
    const out = this.bytes.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

export function parseMessage(bytes: Uint8Array): Message {
  if (bytes.length < HEADER_LENGTH) {
    throw new DnsParseError("message shorter than 12-byte DNS header");
  }
  const reader = new Reader(bytes);
  const registry = new NameTargetRegistry();

  const header: Header = {
    id: reader.u16("header id"),
    flags: reader.u16("header flags"),
    qdCount: reader.u16("header QDCOUNT"),
    anCount: reader.u16("header ANCOUNT"),
    nsCount: reader.u16("header NSCOUNT"),
    arCount: reader.u16("header ARCOUNT"),
  };

  const questions: Question[] = [];
  for (let i = 0; i < header.qdCount; i++) {
    const parsed = readName(bytes, reader.pos, bytes.length, registry);
    reader.pos = parsed.endOffset;
    questions.push({
      name: parsed.name,
      qtype: reader.u16("QTYPE"),
      qclass: reader.u16("QCLASS"),
    });
  }

  const readRecords = (count: number): ResourceRecord[] => {
    const records: ResourceRecord[] = [];
    for (let i = 0; i < count; i++) {
      records.push(readResourceRecord(bytes, reader, registry));
    }
    return records;
  };

  const answers = readRecords(header.anCount);
  const authorities = readRecords(header.nsCount);
  const additionals = readRecords(header.arCount);

  return { header, questions, answers, authorities, additionals };
}

function readResourceRecord(bytes: Uint8Array, reader: Reader, registry: NameTargetRegistry): ResourceRecord {
  const parsedName = readName(bytes, reader.pos, bytes.length, registry);
  reader.pos = parsedName.endOffset;
  const type = reader.u16("TYPE");
  const rrClass = reader.u16("CLASS");
  const ttl = reader.u32("TTL");
  const rdLength = reader.u16("RDLENGTH");
  const rdataEnd = reader.pos + rdLength;
  if (rdataEnd > bytes.length) {
    throw new DnsParseError(`RDLENGTH at offset ${reader.pos - 2} runs past end of message`);
  }

  let rdata: RData;
  if (type === TYPE_CNAME) {
    const target = readName(bytes, reader.pos, rdataEnd, registry);
    if (target.endOffset !== rdataEnd) {
      throw new DnsParseError("CNAME RDATA is not exactly one name");
    }
    rdata = { kind: "cname", name: target.name };
  } else if (type === TYPE_SOA) {
    const mname = readName(bytes, reader.pos, rdataEnd, registry);
    const rname = readName(bytes, mname.endOffset, rdataEnd, registry);
    const tail = new Reader(bytes);
    tail.pos = rname.endOffset;
    const serial = tail.u32("SOA SERIAL");
    const refresh = tail.u32("SOA REFRESH");
    const retry = tail.u32("SOA RETRY");
    const expire = tail.u32("SOA EXPIRE");
    const minimum = tail.u32("SOA MINIMUM");
    if (tail.pos !== rdataEnd) {
      throw new DnsParseError("SOA RDATA is not exactly two names and five integers");
    }
    rdata = { kind: "soa", mname: mname.name, rname: rname.name, serial, refresh, retry, expire, minimum };
  } else {
    const raw = new Reader(bytes);
    raw.pos = reader.pos;
    rdata = { kind: "raw", data: raw.slice(rdLength, "RDATA") };
  }

  reader.pos = rdataEnd;
  return { name: parsedName.name, type, rrClass, ttl, rdata };
}
