import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZone, serializeZone, Zone } from '../src/index';

const ORIGIN = 'example.com.';

function canonical(text: string, origin: string = ORIGIN): string {
  return serializeZone(parseZone(text, origin));
}

function roundTrip(text: string, origin: string = ORIGIN): { zone: Zone; out: string } {
  const zone = parseZone(text, origin);
  const out = serializeZone(zone);
  const zone2 = parseZone(out, origin);
  const out2 = serializeZone(zone2);
  assert.equal(out2, out, 'serialize must be idempotent');
  // Record order is not preserved; compare canonical multisets of records.
  const normalize = (z: Zone): string[] =>
    z.records.map((r) => JSON.stringify(r, (_, v: unknown) => (v instanceof Uint8Array ? Array.from(v) : v))).sort();
  assert.deepEqual(normalize(zone2), normalize(zone), 're-parsed zone must contain identical records');
  return { zone, out };
}

test('$ORIGIN switch, omitted owner, parens, comments and escaped separators', () => {
  const text = [
    '$ORIGIN example.com.',
    '$TTL 600',
    'www A 1.2.3.4 ; a comment',
    '$ORIGIN sub ; relative origin update',
    ' A 5.6.7.8 ; inherits www.example.com, not re-read under sub',
    'host ( A ; comment inside parens',
    '       9.9.9.9 )',
    'a\\.b TXT "x" ; escaped dot stays inside one label',
    '',
  ].join('\n');
  const { out } = roundTrip(text);
  assert.equal(
    out,
    [
      'a\\.b.sub 600 IN TXT "x"',
      'www 600 IN A 1.2.3.4',
      'www 600 IN A 5.6.7.8',
      'host.sub 600 IN A 9.9.9.9',
      '',
    ].join('\n'),
  );
});

test('TXT with 0x00, 0xFF, quotes and semicolons round-trips byte-exact', () => {
  const text = 'txt TXT "\\000" "\\255" "say \\"hi\\"" "a;b" plain "  spaced  "\n';
  const { zone, out } = roundTrip(text);
  assert.equal(zone.records.length, 1);
  const rdata = zone.records[0]!.rdata;
  assert.equal(rdata.type, 'TXT');
  if (rdata.type !== 'TXT') {
    return;
  }
  assert.deepEqual(
    rdata.strings.map((s) => Array.from(s)),
    [
      [0x00],
      [0xff],
      Array.from(Buffer.from('say "hi"', 'latin1')),
      Array.from(Buffer.from('a;b', 'latin1')),
      Array.from(Buffer.from('plain', 'latin1')),
      Array.from(Buffer.from('  spaced  ', 'latin1')),
    ],
  );
  // Canonical text keeps every segment quoted, escaped and separate.
  assert.equal(out, 'txt 300 IN TXT "\\000" "\\255" "say \\"hi\\"" "a;b" "plain" "  spaced  "\n');
});

test('CNAME conflict via case, relative names and decimal escapes', () => {
  assert.throws(
    () => parseZone('WWW CNAME one\nwww CNAME two\n', ORIGIN),
    /at most one CNAME/,
  );
  assert.throws(
    () => parseZone('www CNAME one\nwww.example.com. CNAME two\n', ORIGIN),
    /at most one CNAME/,
  );
  assert.throws(
    () => parseZone('www CNAME one\n\\119\\087w CNAME two\n', ORIGIN),
    /at most one CNAME/,
  );
  // Identical target duplicates merge instead of conflicting.
  const out = canonical('www CNAME one\nWwW.example.com. CNAME ONE.example.com.\n');
  assert.equal(out, 'www 300 IN CNAME one\n');
  // CNAME plus any other type at the same owner is rejected.
  assert.throws(
    () => parseZone('www CNAME one\nwww A 1.2.3.4\n', ORIGIN),
    /may not coexist/,
  );
});

test('duplicates and equivalent IPv6 spellings produce identical canonical output', () => {
  const a = [
    '$TTL 300',
    'www A 1.2.3.4',
    'www A 1.2.3.4 ; duplicate',
    'WWW.example.com. 300 IN A 1.2.3.4 ; duplicate again',
    'v6 AAAA 2001:0db8:0000:0000:0000:ff00:0042:8329',
    '',
  ].join('\n');
  const b = [
    'V6 in 300 AAAA 2001:db8::ff00:42:8329',
    '\\119ww A 1.2.3.4',
    '',
  ].join('\n');
  const outA = canonical(a);
  const outB = canonical(b);
  assert.equal(outA, outB);
  assert.equal(
    outA,
    ['v6 300 IN AAAA 2001:db8::ff00:42:8329', 'www 300 IN A 1.2.3.4', ''].join('\n'),
  );
});

test('all supported types round-trip with values intact', () => {
  const text = [
    '$TTL 3600',
    '@ A 192.0.2.1',
    '@ AAAA 2001:db8::1',
    'alias CNAME @',
    '@ MX 10 mail',
    'mail A 192.0.2.2',
    '_sip._tcp SRV 10 60 5060 sip.example.org.',
    'note TXT "hello" "world"',
    '',
  ].join('\n');
  const { out } = roundTrip(text);
  const again = canonical(out);
  assert.equal(again, out);
  assert.match(out, /^@ 3600 IN A 192\.0\.2\.1$/m);
  assert.match(out, /^@ 3600 IN MX 10 mail$/m);
  assert.match(out, /^_sip\._tcp 3600 IN SRV 10 60 5060 sip\.example\.org\.$/m);
  assert.match(out, /^alias 3600 IN CNAME @$/m);
});

test('rejects unsupported constructs and malformed input', () => {
  const bad: Array<[string, RegExp]> = [
    ['$INCLUDE other.zone\n', /unsupported directive/],
    ['$GENERATE 1-9 $. A 1.2.3.4\n', /unsupported directive/],
    ['www A 1.2.3.4 extra\n', /expects 1 rdata/],
    ['www NS ns1\n', /unsupported record type/],
    ['www A "unterminated\n', /unterminated quoted string/],
    ['www ( A 1.2.3.4\n', /unclosed parenthesis/],
    ['www A 1.2.3.4 )\n', /unmatched closing parenthesis/],
    ['www (( A 1.2.3.4 ))\n', /nested parentheses/],
    ['www 299 A 1.2.3.4\n', /out of range/],
    ['www 86401 A 1.2.3.4\n', /out of range/],
    ['$TTL 1h\n', /invalid TTL/],
    ['www 1h A 1.2.3.4\n', /unsupported record type|invalid/],
    [' A 1.2.3.4\n', /first record may not omit/],
    ['www A 1.2.3.256\n', /invalid IPv4/],
    ['www AAAA 2001:::1\n', /invalid IPv6/],
    ['www MX 65536 mail\n', /out of range 0\.\.65535/],
    ['www SRV 1 2 65536 target\n', /out of range 0\.\.65535/],
    [`www TXT "${'x'.repeat(256)}"\n`, /exceeds 255 bytes/],
    [`${'a'.repeat(64)} A 1.2.3.4\n`, /label length/],
    ['www TXT "bad \\256 escape"\n', /exceeds 255/],
    ['www TXT "bad \\12 escape"\n', /exactly three decimal digits/],
    ['other.org. A 1.2.3.4\n', /outside the zone/],
    ['www 300 A 1.2.3.4\nwww 600 A 1.2.3.5\n', /share a TTL/],
    ['www A 1.2.3.4\nwww 600 A 1.2.3.5\n', /share a TTL/],
  ];
  for (const [text, pattern] of bad) {
    assert.throws(() => parseZone(text, ORIGIN), pattern, JSON.stringify(text));
  }
});

test('TTL and IN may swap order before the type; explicit TTL keeps default', () => {
  const out = canonical('$TTL 700\na 600 IN A 1.2.3.4\nb IN A 1.2.3.5\nc A 1.2.3.6\n');
  assert.equal(
    out,
    [
      'a 600 IN A 1.2.3.4',
      'b 700 IN A 1.2.3.5',
      'c 700 IN A 1.2.3.6',
      '',
    ].join('\n'),
  );
});

test('owner constraints: label and name length limits', () => {
  const ok63 = 'a'.repeat(63);
  assert.doesNotThrow(() => parseZone(`${ok63} A 1.2.3.4\n`, ORIGIN));
  // Wire format: (63+1)*3 + (61+1) + 1(root) = 255 bytes exactly.
  const maxName = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}.`;
  assert.doesNotThrow(() => parseZone(`${maxName} A 1.2.3.4\n`, '.'));
  assert.throws(() => parseZone(`${maxName.slice(0, -1)}x. A 1.2.3.4\n`, '.'), /255 bytes/);
});

test('origin argument must be a legal absolute name', () => {
  assert.throws(() => parseZone('', 'example.com'), /not an absolute name/);
  assert.throws(() => parseZone('', 'exa mple.com.'), /whitespace/);
  assert.doesNotThrow(() => parseZone('', '.'));
  assert.doesNotThrow(() => parseZone('', 'Example.COM.'));
});

test('boundary TTLs, root target, non-ASCII rejection and empty zone', () => {
  assert.doesNotThrow(() => parseZone('a 300 A 1.2.3.4\nb 86400 A 1.2.3.5\n', ORIGIN));
  assert.equal(canonical('a 86400 A 1.2.3.4\n'), 'a 86400 IN A 1.2.3.4\n');
  // Root as an SRV/CNAME-style target stays absolute.
  assert.equal(canonical('_x._tcp SRV 0 0 80 .\n'), '_x._tcp 300 IN SRV 0 0 80 .\n');
  // Non-ASCII bytes must arrive as escapes, never literally.
  assert.throws(() => parseZone('www TXT "héllo"\n', ORIGIN), /non-ASCII/);
  assert.equal(canonical('www TXT "h\\195\\169llo"\n'), 'www 300 IN TXT "h\\195\\169llo"\n');
  // Empty zone serializes to empty text and re-parses.
  assert.equal(canonical(''), '');
  assert.equal(canonical('; only a comment\n'), '');
});
