'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseZone, serializeZone } = require('../dist/index.js');

function roundTripText(text, origin) {
  return serializeZone(parseZone(text, origin));
}

function stableRoundTrip(text, origin) {
  const once = roundTripText(text, origin);
  const twice = roundTripText(once, origin);
  assert.equal(twice, once, 'canonical output must be a fixed point');
  return once;
}

test('$ORIGIN switch, omitted owner, parens, comments and escapes keep names stable', () => {
  const text = [
    '$ORIGIN example.com.',
    '$TTL 600',
    'www 600 IN A 192.0.2.1 ; a comment',
    '   IN A 192.0.2.2',           // inherits www.example.com, TTL 600
    '$ORIGIN sub.example.com.',
    'mail MX ( 10 ; comment inside parens',
    '    mail.example.com. )',
    '  TXT "owned by mail.sub.example.com"', // inherits mail.sub.example.com
    '$ORIGIN other.example.com.',
    '  TXT "still mail.sub.example.com"',    // inherited absolute owner must not drift
    'odd\\.name A 198.51.100.7',             // escaped dot is label content
  ].join('\n');

  const zone = parseZone(text, 'example.com.');
  const owners = zone.records.map((r) => r.owner.map((l) => Buffer.from(l).toString('latin1')).join('.'));
  assert.ok(owners.includes('www.example.com'));
  assert.ok(owners.includes('mail.sub.example.com'));
  assert.ok(owners.includes('odd.name.other.example.com'));
  // the inherited owner after the second $ORIGIN switch stays mail.sub.example.com
  const txts = zone.records.filter((r) => r.rdata.type === 'TXT');
  assert.equal(txts.length, 2);
  for (const t of txts) {
    assert.equal(t.owner.map((l) => Buffer.from(l).toString('latin1')).join('.'), 'mail.sub.example.com');
  }

  const out = stableRoundTrip(text, 'example.com.');
  assert.match(out, /^odd\\\.name\.other\.example\.com\. 600 IN A 198\.51\.100\.7$/m);
  assert.match(out, /^mail\.sub\.example\.com\. 600 IN MX 10 mail\.example\.com\.$/m);
});

test('TXT segments with 0x00, 0xFF, quotes and semicolons round-trip byte-exactly', () => {
  const text = [
    '$ORIGIN example.com.',
    't TXT "\\000" "\\255" "quo\\"te" "semi;colon" plain "a\\032b" "\\\\"',
    't TXT "second" "record"',
  ].join('\n');

  const zone = parseZone(text, 'example.com.');
  const rec = zone.records.find((r) => r.rdata.type === 'TXT' && r.rdata.segments.length === 7);
  assert.ok(rec, 'expected the 7-segment TXT record');
  const segs = rec.rdata.segments.map((s) => Array.from(s));
  assert.deepEqual(segs, [
    [0],
    [255],
    Array.from(Buffer.from('quo"te', 'latin1')),
    Array.from(Buffer.from('semi;colon', 'latin1')),
    Array.from(Buffer.from('plain', 'latin1')),
    Array.from(Buffer.from('a b', 'latin1')),
    [0x5c],
  ]);

  const out = stableRoundTrip(text, 'example.com.');
  assert.match(out, /^t\.example\.com\. 300 IN TXT "\\000" "\\255" "quo\\"te" "semi;colon" "plain" "a b" "\\\\"$/m);
  // reparse and compare bytes again
  const zone2 = parseZone(out, 'example.com.');
  const rec2 = zone2.records.find((r) => r.rdata.type === 'TXT' && r.rdata.segments.length === 7);
  assert.deepEqual(rec2.rdata.segments.map((s) => Array.from(s)), segs);
});

test('CNAME conflicts detected across case, relative and decimal-escape owner spellings', () => {
  const variants = [
    'WWW CNAME a.example.com.\nwww CNAME b.example.com.',
    'www CNAME a.example.com.\nWWW.EXAMPLE.COM. CNAME b.example.com.',
    'www CNAME a.example.com.\n\\119ww CNAME b.example.com.',       // \119 = 'w'
    'www CNAME a.example.com.\n\\087ww CNAME b.example.com.',       // \\087 = 'W'
  ];
  for (const body of variants) {
    assert.throws(
      () => parseZone(`$ORIGIN example.com.\n${body}\n`, 'example.com.'),
      /CNAME/,
      body,
    );
  }
  // CNAME plus any other type at the same owner is rejected
  assert.throws(
    () => parseZone('$ORIGIN example.com.\nwww CNAME a.example.com.\n\\087ww A 192.0.2.1\n', 'example.com.'),
    /CNAME/,
  );
  assert.throws(
    () => parseZone('$ORIGIN example.com.\nwww A 192.0.2.1\nWwW CNAME a.example.com.\n', 'example.com.'),
    /CNAME/,
  );
});

test('duplicates merge and equivalent IPv6 spellings give identical canonical output', () => {
  const a = [
    '$ORIGIN example.com.',
    'host AAAA 2001:0db8:0000:0000:0000:0000:0000:0001',
    'host AAAA 2001:db8::1',   // exact semantic duplicate
    'HOST AAAA 2001:DB8::1',   // duplicate via case
    'host A 192.0.2.1',
    'host A 192.0.2.1',        // duplicate
  ].join('\n');
  const b = [
    '$ORIGIN example.com.',
    'host A 192.0.2.1',
    'host AAAA 2001:db8:0:0:0:0:0:1',
  ].join('\n');

  const outA = serializeZone(parseZone(a, 'example.com.'));
  const outB = serializeZone(parseZone(b, 'example.com.'));
  assert.equal(outA, outB, 'semantically equal zones must serialize identically');
  assert.match(outA, /^host\.example\.com\. 300 IN AAAA 2001:db8::1$/m);
  assert.equal((outA.match(/AAAA/g) || []).length, 1, 'duplicate AAAA merged');
  assert.equal((outA.match(/IN A /g) || []).length, 1, 'duplicate A merged');
});

test('TTL and IN may swap order; explicit TTL does not change the default', () => {
  const text = [
    '$TTL 900',
    '$ORIGIN example.com.',
    'a 600 IN A 192.0.2.1',
    'b IN 600 A 192.0.2.2',
    'c 600 A 192.0.2.3',
    'd A 192.0.2.4',
  ].join('\n');
  const zone = parseZone(text, 'example.com.');
  const ttlOf = (name) => zone.records.find(
    (r) => Buffer.from(r.owner[0]).toString() === name,
  ).ttl;
  assert.equal(ttlOf('a'), 600);
  assert.equal(ttlOf('b'), 600);
  assert.equal(ttlOf('c'), 600);
  assert.equal(ttlOf('d'), 900, 'default stays 900 after explicit TTLs');
});

test('same owner and type must share one TTL', () => {
  assert.throws(
    () => parseZone('$ORIGIN example.com.\nwww 600 A 192.0.2.1\nwww 300 A 192.0.2.2\n', 'example.com.'),
    /TTL/,
  );
  // even an exact-duplicate rdata with a different TTL is a conflict
  assert.throws(
    () => parseZone('$ORIGIN example.com.\nwww 600 A 192.0.2.1\nwww 300 A 192.0.2.1\n', 'example.com.'),
    /TTL/,
  );
  // different types may have different TTLs
  const zone = parseZone(
    '$ORIGIN example.com.\nwww 600 A 192.0.2.1\nwww 300 TXT "ok"\n',
    'example.com.',
  );
  assert.equal(zone.records.length, 2);
});

test('kitchen-sink zone round-trips to a fixed point', () => {
  const zoneText = [
    '$ORIGIN example.com.',
    '$TTL 3600',
    '@ 3600 MX 10 mail.example.com.',
    '@ MX 20 mail2.example.com.',
    'mail A 192.0.2.10',
    'mail AAAA 2001:db8::10',
    '_sip._tcp SRV 10 60 5060 sip.example.com.',
    '_sip._tcp SRV ( 10 60 5061',
    '  sip2.example.com. )',
    'alias CNAME mail.example.com.',
    'txt TXT "v=spf1" "mx" "~all"',
    '$ORIGIN deep.example.com.',
    'x A 203.0.113.1',
  ].join('\n');
  const out = stableRoundTrip(zoneText, 'example.com.');
  assert.match(out, /^\$ORIGIN example\.com\.$/m);
  assert.match(out, /^_sip\._tcp\.example\.com\. 3600 IN SRV 10 60 5060 sip\.example\.com\.$/m);
  assert.match(out, /^x\.deep\.example\.com\. 3600 IN A 203\.0\.113\.1$/m);
  assert.match(out, /^txt\.example\.com\. 3600 IN TXT "v=spf1" "mx" "~all"$/m);
});

test('rejects unsupported constructs and malformed input', () => {
  const origin = 'example.com.';
  const bad = [
    ['$INCLUDE other.file', /directive/],
    ['$GENERATE 1-9 $. A 192.0.2.$', /directive/],
    ['www NS ns1.example.com.', /unsupported record type/],
    ['www SOA a. b. 1 2 3 4 5', /unsupported record type/],
    ['www 1h A 192.0.2.1', /unsupported record type|TTL/],
    ['www 299 A 192.0.2.1', /TTL/],
    ['www 86401 A 192.0.2.1', /TTL/],
    ['$TTL 100', /TTL/],
    ['www A 192.0.2.256', /IPv4/],
    ['www A 192.0.2', /IPv4/],
    ['www AAAA 2001:::1', /IPv6/],
    ['www AAAA 12345::', /IPv6/],
    ['www MX 65536 mail', /preference/],
    ['www MX 10', /MX/],
    ['_s._tcp SRV 1 2 65536 t.example.com.', /port/],
    ['www TXT', /TXT/],
    [`www TXT "${'x'.repeat(256)}"`, /255/],
    ['www TXT "unterminated', /unterminated/],
    ['www TXT ( "a" ', /unclosed/],
    ['www TXT ( ( "a" ) )', /nested/],
    ['www TXT "a" )', /unmatched/],
    ['www TXT "bad\\256escape"', /255/],
    ['www TXT "bad\\12escape"', /escape/],
    ['www TXT "caf\u00e9"', /non-ASCII/],
    ['  A 192.0.2.1', /first record/],
    ['other.org. A 192.0.2.1', /outside the zone/],
    ['sub.other.org. A 192.0.2.1', /outside the zone/],
    [`${'a'.repeat(64)}.example.com. A 192.0.2.1`, /63/],
    ['www CNAME', /CNAME/],
    ['www 600 600 A 192.0.2.1', /unsupported record type/],
  ];
  for (const [body, pattern] of bad) {
    assert.throws(() => parseZone(`${body}\n`, origin), pattern, body);
  }
});

test('owner at the zone apex and boundary names are accepted', () => {
  const zone = parseZone(
    '$ORIGIN example.com.\n@ A 192.0.2.1\nsub.example.com. A 192.0.2.2\n',
    'example.com.',
  );
  assert.equal(zone.records.length, 2);
});

test('record targets may live outside the zone', () => {
  const zone = parseZone(
    '$ORIGIN example.com.\nwww CNAME cdn.other.org.\n@ MX 10 mail.other.org.\n',
    'example.com.',
  );
  const out = serializeZone(zone);
  assert.match(out, /CNAME cdn\.other\.org\./);
  assert.match(out, /MX 10 mail\.other\.org\./);
});

test('name length limits enforced on wire format', () => {
  // 253 bytes of labels + root is fine only up to 255 total
  const label = 'a'.repeat(63);
  // wire bytes: (64+64+64+50+8+4)+1 = 255 including origin example.com
  const name = `${label}.${label}.${label}.${'b'.repeat(49)}`;
  const zone = parseZone(`$ORIGIN example.com.\n${name}.example.com. A 192.0.2.1\n`, 'example.com.');
  void zone;
  const tooLong = `${label}.${label}.${label}.${'b'.repeat(50)}`;
  assert.throws(
    () => parseZone(`$ORIGIN example.com.\n${tooLong}.example.com. A 192.0.2.1\n`, 'example.com.'),
    /255/,
  );
});

test('TTL boundaries 300 and 86400 are accepted', () => {
  const zone = parseZone(
    '$ORIGIN example.com.\nlo 300 TXT "a"\nhi 86400 TXT "b"\n',
    'example.com.',
  );
  assert.equal(zone.records.length, 2);
});

test('IPv4 leading zeros and IPv6 embedded IPv4 canonicalize by address bytes', () => {
  const zone = parseZone(
    [
      '$ORIGIN example.com.',
      'a A 192.0.2.1',
      'a A 192.000.002.001', // same address bytes: duplicate
      'v AAAA ::ffff:192.0.2.1',
      'v AAAA 0:0:0:0:0:ffff:c000:201', // same 16 bytes: duplicate
    ].join('\n'),
    'example.com.',
  );
  const out = serializeZone(zone);
  assert.equal((out.match(/IN A /g) || []).length, 1);
  assert.match(out, /^v\.example\.com\. 300 IN AAAA ::ffff:c000:201$/m);
  assert.equal((out.match(/AAAA/g) || []).length, 1);
});

test('unquoted TXT escapes, empty segment and apex owner inheritance', () => {
  const zone = parseZone(
    '$ORIGIN example.com.\n@ TXT a\\;b "" "x"\n TXT "inherited"\n',
    'example.com.',
  );
  const recs = zone.records;
  assert.equal(recs.length, 2);
  const first = recs[0].rdata;
  assert.equal(first.type, 'TXT');
  assert.deepEqual(Array.from(first.segments[0]), Array.from(Buffer.from('a;b', 'latin1')));
  assert.deepEqual(Array.from(first.segments[1]), []);
  for (const r of recs) assert.equal(r.owner.length, 2, 'owner is the apex');
  const out = serializeZone(zone);
  assert.match(out, /^example\.com\. 300 IN TXT "a;b" "" "x"$/m);
  stableRoundTrip(out, 'example.com.');
});

test('relative $ORIGIN chains resolve against the current origin', () => {
  const zone = parseZone(
    '$ORIGIN example.com.\n$ORIGIN sub\n$ORIGIN deep\nhost A 192.0.2.1\n',
    'example.com.',
  );
  const out = serializeZone(zone);
  assert.match(out, /^host\.deep\.sub\.example\.com\. 300 IN A 192\.0\.2\.1$/m);
});

test('escaped @ is label content, bare @ is the origin', () => {
  const zone = parseZone(
    '$ORIGIN example.com.\n\\@ A 192.0.2.1\n@ A 192.0.2.2\n',
    'example.com.',
  );
  const out = serializeZone(zone);
  assert.match(out, /^\\@\.example\.com\. 300 IN A 192\.0\.2\.1$/m);
  assert.match(out, /^example\.com\. 300 IN A 192\.0\.2\.2$/m);
});
