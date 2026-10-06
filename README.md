# zonefile

TypeScript library for registrar DNS zone-file import and canonical export.

## API

```ts
import { parseZone, serializeZone } from 'zonefile';

const zone = parseZone(text, 'example.com.'); // origin must be an absolute name
const text2 = serializeZone(zone);            // canonical form
```

- `parseZone(text, origin): Zone` — parses a master-file-format zone.
  Throws `ZoneError` on any unsupported or malformed construct; never
  returns partial data.
- `serializeZone(zone): string` — canonical export. Re-parsing it yields
  identical absolute names, TTLs, record values and TXT segment bytes and
  boundaries. Semantically equivalent inputs serialize to identical text.

Supported types: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV`.

## Data model

- `ZoneName` — absolute name as a list of raw-byte labels (root = `[]`).
- `ZoneRecord` — `{ owner, ttl, rdata }`; `rdata` is a discriminated union
  keyed by `type`. Addresses are raw bytes (4/16), TXT is a list of
  raw-byte segments (never decoded as Unicode, never merged or re-split).

## Parsing rules

- `$ORIGIN` (may be relative to the current origin), `$TTL`, `;` comments,
  quoted strings and non-nesting `( )` continuations.
- `\` followed by a digit consumes exactly three decimal digits (<= 255);
  otherwise it escapes the next single character.
- Unescaped `@` = current origin; unescaped trailing dot = absolute name;
  other names are completed with the current origin.
- Leading whitespace on a record line omits the owner, inheriting the most
  recent record's absolute owner (never re-interpreted across `$ORIGIN`).
  The first record may not omit its owner.
- Type and `IN` are case-insensitive; `IN` may be omitted; TTL and `IN`
  may appear in either order before the type. TTL is decimal seconds in
  300..86400; a missing TTL uses the current `$TTL` (initially 300).
- Names compare by label bytes with ASCII case folding; escaped dots are
  label content. Labels are 1..63 bytes; a full name is <= 255 bytes on
  the wire. Owners must lie inside the initial origin; rdata targets may
  point outside the zone.
- Records sharing an owner and type must share a TTL; exact duplicates
  merge. An owner has at most one CNAME target and no CNAME alongside
  other types.
- Unknown types, `$INCLUDE`, `$GENERATE`, unit suffixed TTLs, unterminated
  quotes and unclosed parentheses are rejected.

## Develop

```sh
npm install
npm test   # builds with tsc, then runs node --test
```
