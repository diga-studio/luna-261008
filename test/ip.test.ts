import { test } from "node:test";
import assert from "node:assert/strict";
import { cidrToInterval, formatIp, parseIp } from "../src/ip.js";

test("IPv4 parse/format round-trip", () => {
  for (const ip of ["0.0.0.0", "10.0.0.1", "192.168.1.7", "255.255.255.255"]) {
    const parsed = parseIp(ip);
    assert.equal(parsed.family, 4);
    assert.equal(formatIp(parsed.family, parsed.value), ip);
  }
});

test("IPv6 parse/format round-trip", () => {
  const cases: Array<[string, string]> = [
    ["::", "::"],
    ["::1", "::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8"],
    ["fe80:0:0:0:a:b:c:d", "fe80::a:b:c:d"],
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
  ];
  for (const [input, canonical] of cases) {
    const parsed = parseIp(input);
    assert.equal(parsed.family, 6);
    assert.equal(formatIp(parsed.family, parsed.value), canonical);
  }
});

test("IPv4-mapped IPv6 stays in IPv6 family", () => {
  const parsed = parseIp("::ffff:10.0.0.1");
  assert.equal(parsed.family, 6);
  assert.equal(parsed.value, 0xffff0a000001n);
});

test("CIDR with non-zero host bits is normalized to network prefix", () => {
  const interval = cidrToInterval("10.1.2.3/8");
  assert.equal(formatIp(4, interval.lo), "10.0.0.0");
  assert.equal(formatIp(4, interval.hi), "10.255.255.255");
});

test("CIDR interval boundaries", () => {
  const v4all = cidrToInterval("0.0.0.0/0");
  assert.equal(v4all.lo, 0n);
  assert.equal(v4all.hi, 0xffffffffn);
  const v4host = cidrToInterval("192.168.1.7/32");
  assert.equal(v4host.lo, v4host.hi);
  const v6all = cidrToInterval("::/0");
  assert.equal(v6all.lo, 0n);
  assert.equal(v6all.hi, (1n << 128n) - 1n);
  const v6host = cidrToInterval("2001:db8::1/128");
  assert.equal(v6host.lo, v6host.hi);
});
