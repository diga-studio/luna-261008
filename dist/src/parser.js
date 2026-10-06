export class DnsParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "DnsParseError";
    }
}
const MAX_NAME_ENCODED_LENGTH = 255;
const TYPE_CNAME = 5;
const TYPE_SOA = 6;
/**
 * Parses a domain name starting at `start`. Bytes of the name's own encoding
 * must lie within `[start, limit)`; pointer targets may lie anywhere earlier
 * in the message but must be registered boundaries of fully parsed names.
 */
function parseName(bytes, start, limit, boundaries) {
    const labels = [];
    const ownBoundaries = [];
    let encodedLength = 0;
    let consumed = 0;
    let jumped = false;
    let cursor = start;
    for (;;) {
        if (cursor >= limit) {
            throw new DnsParseError("name encoding exceeds its boundary");
        }
        const tag = bytes[cursor];
        const kind = tag & 0xc0;
        if (kind === 0x00) {
            const length = tag;
            if (length === 0) {
                if (!jumped)
                    consumed = cursor + 1 - start;
                ownBoundaries.push(cursor);
                encodedLength += 1;
                break;
            }
            if (cursor + 1 + length > limit) {
                throw new DnsParseError("label exceeds its boundary");
            }
            ownBoundaries.push(cursor);
            labels.push(bytes.slice(cursor + 1, cursor + 1 + length));
            encodedLength += 1 + length;
            if (encodedLength > MAX_NAME_ENCODED_LENGTH) {
                throw new DnsParseError("expanded name encoding exceeds 255 bytes");
            }
            cursor += 1 + length;
        }
        else if (kind === 0xc0) {
            if (cursor + 1 >= limit) {
                throw new DnsParseError("truncated compression pointer");
            }
            const target = ((tag & 0x3f) << 8) | bytes[cursor + 1];
            if (!boundaries.has(target)) {
                throw new DnsParseError(`compression pointer target ${target} is not a verified name boundary`);
            }
            if (!jumped) {
                consumed = cursor + 2 - start;
                jumped = true;
            }
            ownBoundaries.push(cursor);
            cursor = target;
        }
        else {
            throw new DnsParseError("reserved label tag (01/10) rejected");
        }
    }
    for (const offset of ownBoundaries) {
        boundaries.add(offset);
    }
    return { labels, consumed };
}
class Reader {
    bytes;
    boundaries;
    offset;
    constructor(bytes, boundaries, offset = 0) {
        this.bytes = bytes;
        this.boundaries = boundaries;
        this.offset = offset;
    }
    get position() {
        return this.offset;
    }
    u16() {
        if (this.offset + 2 > this.bytes.length) {
            throw new DnsParseError("unexpected end of message");
        }
        const value = (this.bytes[this.offset] << 8) | this.bytes[this.offset + 1];
        this.offset += 2;
        return value;
    }
    u32() {
        if (this.offset + 4 > this.bytes.length) {
            throw new DnsParseError("unexpected end of message");
        }
        const b = this.bytes;
        const value = (b[this.offset] * 0x1000000 +
            ((b[this.offset + 1] << 16) |
                (b[this.offset + 2] << 8) |
                b[this.offset + 3])) >>>
            0;
        this.offset += 4;
        return value;
    }
    name(limit) {
        const parsed = parseName(this.bytes, this.offset, limit, this.boundaries);
        this.offset += parsed.consumed;
        return parsed;
    }
    skip(count) {
        if (this.offset + count > this.bytes.length) {
            throw new DnsParseError("unexpected end of message");
        }
        this.offset += count;
    }
}
function parseHeader(reader) {
    const id = reader.u16();
    const flags = reader.u16();
    const qdcount = reader.u16();
    const ancount = reader.u16();
    const nscount = reader.u16();
    const arcount = reader.u16();
    return { id, flags, qdcount, ancount, nscount, arcount };
}
function parseQuestion(reader, limit) {
    const { labels } = reader.name(limit);
    const qtype = reader.u16();
    const qclass = reader.u16();
    return { name: labels, qtype, qclass };
}
function parseRData(reader, type, rdStart, rdEnd) {
    const bytes = reader.bytes;
    if (type === TYPE_CNAME) {
        const { labels, consumed } = parseName(bytes, rdStart, rdEnd, reader.boundaries);
        if (consumed !== rdEnd - rdStart) {
            throw new DnsParseError("CNAME RDATA is not exactly one name");
        }
        return { kind: "cname", name: labels };
    }
    if (type === TYPE_SOA) {
        const mname = parseName(bytes, rdStart, rdEnd, reader.boundaries);
        const rnameOffset = rdStart + mname.consumed;
        const rname = parseName(bytes, rnameOffset, rdEnd, reader.boundaries);
        let cursor = rnameOffset + rname.consumed;
        if (cursor + 20 !== rdEnd) {
            throw new DnsParseError("SOA RDATA is not two names plus five integers");
        }
        const readU32 = (at) => ((bytes[at] * 0x1000000 +
            ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])) >>>
            0);
        const serial = readU32(cursor);
        const refresh = readU32(cursor + 4);
        const retry = readU32(cursor + 8);
        const expire = readU32(cursor + 12);
        const minimum = readU32(cursor + 16);
        return {
            kind: "soa",
            mname: mname.labels,
            rname: rname.labels,
            serial,
            refresh,
            retry,
            expire,
            minimum,
        };
    }
    return { kind: "opaque", data: bytes.slice(rdStart, rdEnd) };
}
function parseResourceRecord(reader, limit) {
    const { labels } = reader.name(limit);
    const type = reader.u16();
    const rrClass = reader.u16();
    const ttl = reader.u32();
    const rdlength = reader.u16();
    const rdStart = reader.position;
    const rdEnd = rdStart + rdlength;
    if (rdEnd > limit) {
        throw new DnsParseError("RDATA exceeds message boundary");
    }
    const rdata = parseRData(reader, type, rdStart, rdEnd);
    reader.skip(rdlength);
    return { name: labels, type, class: rrClass, ttl, rdata };
}
export function parseMessage(bytes) {
    const boundaries = new Set();
    const reader = new Reader(bytes, boundaries);
    const header = parseHeader(reader);
    const limit = bytes.length;
    const questions = [];
    for (let i = 0; i < header.qdcount; i++) {
        questions.push(parseQuestion(reader, limit));
    }
    const answers = [];
    for (let i = 0; i < header.ancount; i++) {
        answers.push(parseResourceRecord(reader, limit));
    }
    const authorities = [];
    for (let i = 0; i < header.nscount; i++) {
        authorities.push(parseResourceRecord(reader, limit));
    }
    const additionals = [];
    for (let i = 0; i < header.arcount; i++) {
        additionals.push(parseResourceRecord(reader, limit));
    }
    return { header, questions, answers, authorities, additionals };
}
