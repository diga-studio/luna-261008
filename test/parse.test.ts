import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { parseMessage, DnsParseError, type DomainName } from "../src/index.js";

class MsgBuilder {
  private readonly bytes: number[] = [];

  get pos(): number {
    return this.bytes.length;
  }

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >> 8).u8(value);
  }

  u32(value: number): this {
    return this.u8(value >>> 24).u8(value >>> 16).u8(value >>> 8).u8(value);
  }

  raw(values: number[]): this {
    for (const v of values) this.u8(v);
    return this;
  }

  label(values: number[]): this {
    this.u8(values.length);
    return this.raw(values);
  }

  ptr(offset: number): this {
    return this.u16(0xc000 | offset);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function str(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function header(id: number, flags: number, qd: number, an: number, ns: number, ar: number): MsgBuilder {
  return new MsgBuilder().u16(id).u16(flags).u16(qd).u16(an).u16(ns).u16(ar);
}

function toArrays(name: DomainName): number[][] {
  return name.map((label) => [...label]);
}

function expectDnsError(bytes: Uint8Array): void {
  assert.throws(
    () => parseMessage(bytes),
    (err: unknown) => err instanceof DnsParseError,
  );
}

describe("parseMessage", () => {
  test("parses multi-level compression, binary labels, SOA external suffix, and later references", () => {
    const b = header(0xbeef, 0x0100, 1, 1, 1, 2);

    // Question: label ['.', NUL, 'A'] + "example" + "com" + root.
    b.label([0x2e, 0x00, 0x41]);
    const posExample = b.pos;
    b.label(str("example"));
    b.label(str("com"));
    const posRoot = b.pos;
    b.u8(0);
    b.u16(1).u16(1); // QTYPE=A, QCLASS=IN

    // Answer: CNAME "x.example.com" (label + pointer), rdata "www.example.com" (label + pointer).
    const posX = b.pos;
    b.label(str("x"));
    const posXPtr = b.pos;
    b.ptr(posExample);
    b.u16(5).u16(1).u32(3600);
    const cnameRdata = new MsgBuilder().label(str("www")).ptr(posExample);
    b.u16(6).raw([...cnameRdata.build()]);

    // Authority: SOA, name is a pointer to the pointer byte above (pointer-to-pointer).
    b.ptr(posXPtr);
    b.u16(6).u16(1).u32(60);
    const soaRdata = new MsgBuilder();
    const soaStart = b.pos + 2; // after RDLENGTH
    const posNs = soaStart;
    soaRdata.label(str("ns")).ptr(posExample); // mname references external suffix
    soaRdata.label(str("admin")).ptr(posX); // rname references external suffix
    soaRdata.u32(2024010101).u32(7200).u32(3600).u32(1209600).u32(300);
    const soaBytes = [...soaRdata.build()];
    b.u16(soaBytes.length).raw(soaBytes);

    // Additional 1: A record named by a pointer to the mname label inside SOA RDATA.
    b.ptr(posNs);
    b.u16(1).u16(1).u32(300).u16(4).raw([127, 0, 0, 1]);

    // Additional 2: A record named by a pointer to the root terminator byte.
    b.ptr(posRoot);
    b.u16(1).u16(1).u32(0).u16(4).raw([8, 8, 8, 8]);

    const msg = parseMessage(b.build());

    assert.equal(msg.header.id, 0xbeef);
    assert.equal(msg.header.flags, 0x0100);
    assert.deepEqual(
      [msg.header.qdCount, msg.header.anCount, msg.header.nsCount, msg.header.arCount],
      [1, 1, 1, 2],
    );

    assert.deepEqual(toArrays(msg.questions[0]!.name), [[0x2e, 0x00, 0x41], str("example"), str("com")]);
    assert.equal(msg.questions[0]!.qtype, 1);
    assert.equal(msg.questions[0]!.qclass, 1);

    const answer = msg.answers[0]!;
    assert.deepEqual(toArrays(answer.name), [str("x"), str("example"), str("com")]);
    assert.equal(answer.type, 5);
    assert.equal(answer.rrClass, 1);
    assert.equal(answer.ttl, 3600);
    assert.equal(answer.rdata.kind, "cname");
    if (answer.rdata.kind === "cname") {
      assert.deepEqual(toArrays(answer.rdata.name), [str("www"), str("example"), str("com")]);
    }

    const authority = msg.authorities[0]!;
    assert.deepEqual(toArrays(authority.name), [str("example"), str("com")]);
    assert.equal(authority.type, 6);
    assert.equal(authority.ttl, 60);
    assert.equal(authority.rdata.kind, "soa");
    if (authority.rdata.kind === "soa") {
      assert.deepEqual(toArrays(authority.rdata.mname), [str("ns"), str("example"), str("com")]);
      assert.deepEqual(toArrays(authority.rdata.rname), [str("admin"), str("x"), str("example"), str("com")]);
      assert.equal(authority.rdata.serial, 2024010101);
      assert.equal(authority.rdata.refresh, 7200);
      assert.equal(authority.rdata.retry, 3600);
      assert.equal(authority.rdata.expire, 1209600);
      assert.equal(authority.rdata.minimum, 300);
    }

    const additional1 = msg.additionals[0]!;
    assert.deepEqual(toArrays(additional1.name), [str("ns"), str("example"), str("com")]);
    assert.equal(additional1.type, 1);
    assert.equal(additional1.ttl, 300);
    assert.deepEqual(additional1.rdata, { kind: "raw", data: Uint8Array.from([127, 0, 0, 1]) });

    const additional2 = msg.additionals[1]!;
    assert.deepEqual(toArrays(additional2.name), []);
    assert.equal(additional2.ttl, 0);
    assert.deepEqual(additional2.rdata, { kind: "raw", data: Uint8Array.from([8, 8, 8, 8]) });
  });

  test("parses root domain as an empty label list", () => {
    const b = header(1, 0, 1, 0, 0, 0);
    b.u8(0).u16(255).u16(1);
    const msg = parseMessage(b.build());
    assert.deepEqual(toArrays(msg.questions[0]!.name), []);
    assert.equal(msg.questions[0]!.qtype, 255);
  });

  test("rejects a pointer into the interior of a label", () => {
    const b = header(1, 0, 1, 1, 0, 0);
    b.label(str("example")).label(str("com")).u8(0);
    b.u16(1).u16(1);
    const interior = 13; // second byte of "example"
    b.ptr(interior).u16(1).u16(1).u32(0).u16(0);
    expectDnsError(b.build());
  });

  test("rejects a pointer targeting a plain field", () => {
    const b = header(1, 0, 1, 1, 0, 0);
    b.label(str("a")).u8(0);
    const qtypeOffset = b.pos;
    b.u16(1).u16(1);
    b.ptr(qtypeOffset).u16(1).u16(1).u32(0).u16(0);
    expectDnsError(b.build());
  });

  test("rejects a pointer into unknown-type RDATA", () => {
    const b = header(1, 0, 0, 1, 0, 1);
    b.u8(0); // root name
    b.u16(99).u16(1).u32(0);
    const rdataStart = b.pos + 2;
    b.u16(3).raw([1, 0x61, 0]); // opaque RDATA that merely looks like a name
    b.ptr(rdataStart).u16(1).u16(1).u32(0).u16(0);
    expectDnsError(b.build());
  });

  test("rejects a pointer to itself", () => {
    const b = header(1, 0, 1, 0, 0, 0);
    b.ptr(12).u16(1).u16(1);
    expectDnsError(b.build());
  });

  test("rejects a forward pointer", () => {
    const b = header(1, 0, 2, 0, 0, 0);
    b.u8(0).u16(1).u16(1);
    const self = b.pos;
    b.ptr(self + 4).u16(1).u16(1);
    expectDnsError(b.build());
  });

  test("rejects a name whose own encoding crosses RDLENGTH but stays in the message", () => {
    const b = header(1, 0, 0, 1, 0, 0);
    b.u8(0); // root name
    b.u16(5).u16(1).u32(0);
    b.u16(2); // RDLENGTH=2, but the name needs 5 bytes
    b.raw([3, 0x77, 0x77, 0x77, 0]); // "www" root-terminated, still inside the message
    expectDnsError(b.build());
  });

  test("rejects reserved label tags 01 and 10", () => {
    const b1 = header(1, 0, 1, 0, 0, 0);
    b1.u8(0x40).u16(1).u16(1);
    expectDnsError(b1.build());

    const b2 = header(1, 0, 1, 0, 0, 0);
    b2.u8(0x80).u16(1).u16(1);
    expectDnsError(b2.build());
  });

  test("rejects an expanded name longer than 255 bytes", () => {
    const b = header(1, 0, 1, 0, 0, 0);
    const label63 = new Array<number>(63).fill(0x61);
    b.label(label63).label(label63).label(label63).label(label63).u8(0);
    b.u16(1).u16(1);
    expectDnsError(b.build());
  });

  test("rejects CNAME RDATA that is not exactly one name", () => {
    const b = header(1, 0, 0, 1, 0, 0);
    b.u8(0);
    b.u16(5).u16(1).u32(0);
    b.u16(4).raw([1, 0x61, 0, 0]); // one name plus a trailing byte inside RDLENGTH
    expectDnsError(b.build());
  });

  test("rejects a truncated message", () => {
    expectDnsError(Uint8Array.from([0, 1, 0]));
    const b = header(1, 0, 1, 0, 0, 0);
    b.label(str("abc")); // no terminator
    expectDnsError(b.build());
  });
});
