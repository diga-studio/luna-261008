import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage, DnsParseError } from "../src/index.js";
function u16(v) {
    return [(v >> 8) & 0xff, v & 0xff];
}
function u32(v) {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function label(s) {
    const octets = typeof s === "string" ? [...Buffer.from(s, "latin1")] : s;
    return [octets.length, ...octets];
}
function ptr(offset) {
    return [0xc0 | (offset >> 8), offset & 0xff];
}
function header(qd, an, ns, ar) {
    return [...u16(0x1234), ...u16(0x8180), ...u16(qd), ...u16(an), ...u16(ns), ...u16(ar)];
}
function msg(...parts) {
    return Uint8Array.from(parts.flat());
}
function labelArrays(labels) {
    return labels.map((l) => [...l]);
}
test("valid: multi-level compression, binary labels, SOA suffix reuse", () => {
    const bytes = msg(header(1, 2, 1, 1), // 0-11
    label([0x2e, 0x00, 0x61]), // 12-15: label containing '.' and NUL
    label("example"), // 16-23
    label("com"), // 24-27
    [0], // 28: root terminator
    u16(1), u16(1), // 29-32: QTYPE, QCLASS
    ptr(12), // 33-34: answer1 name -> question name
    u16(1), u16(1), u32(300), u16(4), [1, 2, 3, 4], // 35-48
    label("mail"), // 49-53
    ptr(16), // 54-55: -> "example.com"
    u16(5), u16(1), u32(60), // 56-63
    u16(6), label("web"), ptr(12), // 64-71: CNAME rdata, one exact name
    ptr(49), // 72-73: authority name -> "mail" label, whose name hops via ptr @54
    u16(6), u16(1), u32(3600), // 74-81
    u16(38), // 82-83: RDLENGTH
    label("ns"), ptr(16), // 84-88: mname = ns.example.com ("ns" label @84)
    label("hostmaster"), ptr(16), // 89-101: rname references external suffix
    u32(2024010101), u32(7200), u32(3600), u32(1209600), u32(300), // 102-121
    ptr(84), // 122-123: additional name -> suffix inside SOA rdata
    u16(2), u16(1), u32(100), u16(2), ptr(12));
    assert.equal(bytes.length, 136);
    const m = parseMessage(bytes);
    assert.equal(m.header.id, 0x1234);
    assert.equal(m.header.flags, 0x8180);
    assert.deepEqual([m.header.qdcount, m.header.ancount, m.header.nscount, m.header.arcount], [1, 2, 1, 1]);
    const qname = [[0x2e, 0x00, 0x61], [...Buffer.from("example")], [...Buffer.from("com")]];
    assert.deepEqual(labelArrays(m.questions[0].name), qname);
    assert.equal(m.questions[0].qtype, 1);
    assert.equal(m.questions[0].qclass, 1);
    const a1 = m.answers[0];
    assert.deepEqual(labelArrays(a1.name), qname);
    assert.equal(a1.type, 1);
    assert.equal(a1.class, 1);
    assert.equal(a1.ttl, 300);
    assert.deepEqual(a1.rdata, { kind: "opaque", data: Uint8Array.from([1, 2, 3, 4]) });
    const a2 = m.answers[1];
    assert.deepEqual(labelArrays(a2.name), [[...Buffer.from("mail")], [...Buffer.from("example")], [...Buffer.from("com")]]);
    assert.equal(a2.ttl, 60);
    assert.equal(a2.rdata.kind, "cname");
    if (a2.rdata.kind === "cname") {
        assert.deepEqual(labelArrays(a2.rdata.name), [[...Buffer.from("web")], ...qname]);
    }
    const soa = m.authorities[0];
    assert.deepEqual(labelArrays(soa.name), labelArrays(a2.name));
    assert.equal(soa.ttl, 3600);
    assert.equal(soa.rdata.kind, "soa");
    if (soa.rdata.kind === "soa") {
        assert.deepEqual(labelArrays(soa.rdata.mname), [
            [...Buffer.from("ns")],
            [...Buffer.from("example")],
            [...Buffer.from("com")],
        ]);
        assert.deepEqual(labelArrays(soa.rdata.rname), [
            [...Buffer.from("hostmaster")],
            [...Buffer.from("example")],
            [...Buffer.from("com")],
        ]);
        assert.equal(soa.rdata.serial, 2024010101);
        assert.equal(soa.rdata.refresh, 7200);
        assert.equal(soa.rdata.retry, 3600);
        assert.equal(soa.rdata.expire, 1209600);
        assert.equal(soa.rdata.minimum, 300);
    }
    const add = m.additionals[0];
    assert.deepEqual(labelArrays(add.name), [
        [...Buffer.from("ns")],
        [...Buffer.from("example")],
        [...Buffer.from("com")],
    ]);
    assert.equal(add.type, 2);
    assert.deepEqual(add.rdata, { kind: "opaque", data: Uint8Array.from([0xc0, 0x0c]) });
});
test("valid: pointer to a root terminator byte yields the root name", () => {
    const bytes = msg(header(1, 1, 0, 0), label("a"), [0], // 12-14: name "a", root terminator @14
    u16(1), u16(1), // 15-18
    ptr(14), // 19-20: answer name -> root terminator
    u16(1), u16(1), u32(0), u16(0));
    const m = parseMessage(bytes);
    assert.deepEqual(labelArrays(m.answers[0].name), []);
});
test("valid: pointer to a pointer first byte resolves the chain", () => {
    const bytes = msg(header(1, 2, 0, 0), label("a"), [0], // 12-14: question name "a"
    u16(1), u16(1), // 15-18
    ptr(12), // 19-20: answer1 name -> "a" (pointer first byte @19)
    u16(1), u16(1), u32(0), u16(0), // 21-30
    ptr(19), // 31-32: answer2 name -> pointer byte of answer1
    u16(1), u16(1), u32(0), u16(0));
    const m = parseMessage(bytes);
    assert.deepEqual(labelArrays(m.answers[1].name), [[0x61]]);
});
test("reject: pointer into the interior of a label", () => {
    const bytes = msg(header(1, 1, 0, 0), label("www"), [0], // 12-16
    u16(1), u16(1), // 17-20
    ptr(13), // 21-22: inside the "www" label bytes
    u16(1), u16(1), u32(0), u16(0));
    assert.throws(() => parseMessage(bytes), DnsParseError);
});
test("reject: pointer into header and fixed fields", () => {
    const intoHeader = msg(header(0, 1, 0, 0), ptr(2), // 12-13: -> FLAGS field
    u16(1), u16(1), u32(0), u16(0));
    assert.throws(() => parseMessage(intoHeader), DnsParseError);
    const intoTtl = msg(header(0, 2, 0, 0), [0], // 12: root name
    u16(1), u16(1), u32(0), u16(0), // 13-22: ttl @17
    ptr(17), // 23-24: -> TTL field of previous record
    u16(1), u16(1), u32(0), u16(0));
    assert.throws(() => parseMessage(intoTtl), DnsParseError);
});
test("reject: pointer into unknown-type RDATA", () => {
    const bytes = msg(header(0, 2, 0, 0), [0], // 12: root name
    u16(99), u16(1), u32(0), u16(3), // 13-22
    [1, 0x61, 0], // 23-25: opaque rdata that merely looks like a name
    ptr(23), // 26-27: -> inside opaque rdata
    u16(1), u16(1), u32(0), u16(0));
    assert.throws(() => parseMessage(bytes), DnsParseError);
});
test("reject: pointer to itself or to a later offset", () => {
    const self = msg(header(0, 1, 0, 0), ptr(12), // 12-13: -> itself
    u16(1), u16(1), u32(0), u16(0));
    assert.throws(() => parseMessage(self), DnsParseError);
    const forward = msg(header(1, 0, 0, 0), ptr(20), // 12-13: -> not-yet-parsed name below
    u16(1), u16(1), // 14-17
    [0, 0], // 18-19: padding
    label("a"), [0]);
    assert.throws(() => parseMessage(forward), DnsParseError);
});
test("reject: name encoding crosses RDLENGTH but stays in message", () => {
    const bytes = msg(header(0, 1, 0, 0), [0], // 12: root name
    u16(5), u16(1), u32(0), u16(2), // 13-22: CNAME, RDLENGTH=2
    [3, 0x77], // 23-24: label length 3 needs 3 more bytes, only 1 in rdata
    [0x77, 0x77, 0]);
    assert.throws(() => parseMessage(bytes), DnsParseError);
});
test("reject: reserved label tags 01 and 10", () => {
    for (const tag of [0x40, 0x80]) {
        const bytes = msg(header(1, 0, 0, 0), [tag, 0x61, 0], u16(1), u16(1));
        assert.throws(() => parseMessage(bytes), DnsParseError);
    }
});
test("reject: CNAME rdata is not exactly one name", () => {
    const bytes = msg(header(0, 1, 0, 0), [0], // 12
    u16(5), u16(1), u32(0), u16(3), // 13-22: RDLENGTH=3
    [0, 0, 0]);
    assert.throws(() => parseMessage(bytes), DnsParseError);
});
test("reject: expanded name encoding exceeds 255 bytes", () => {
    const big = label(new Array(63).fill(0x61));
    const bytes = msg(header(1, 0, 0, 0), big, big, big, big, [0], u16(1), u16(1));
    assert.throws(() => parseMessage(bytes), DnsParseError);
});
