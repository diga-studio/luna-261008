# zonefile

Registrar-grade DNS zone file import and canonical export (TypeScript).

Supports `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV` records, `$ORIGIN` / `$TTL`
directives, `;` comments, quoted strings, and parentheses continuations.

## API

```ts
import { parseZone, serializeZone } from 'zonefile';

const zone = parseZone(text, 'example.com.'); // throws ZoneParseError on invalid input
const text2 = serializeZone(zone);            // canonical, deterministic output
```

Core property: `serializeZone` output reparses to the same absolute names,
TTLs, record values, and TXT segment bytes/boundaries; semantically equal
inputs serialize to byte-identical text.

## Data model

- `DnsName`: array of labels, each a `Uint8Array` (root = empty array).
  Equality folds ASCII letter case only; escaped dots stay label content.
- `ZoneRecord`: `{ owner: DnsName, ttl: number, rdata: Rdata }` where
  `Rdata` is a discriminated union on `type` (`A`/`AAAA` hold raw address
  bytes, `TXT` holds `segments: Uint8Array[]` — never decoded as Unicode).
- `Zone`: `{ origin: DnsName, records: ZoneRecord[] }` with `origin` being
  the initial `$ORIGIN`.

## Normalization rules

- Records are sorted canonically (RFC 4034 name order, then type, then rdata).
- Exact duplicates merge; conflicting TTLs for the same owner+type are rejected.
- CNAME conflicts (multiple targets, or coexisting with other types) are rejected.
- Unsupported types/directives (`$INCLUDE`, `$GENERATE`, unit TTLs, …) and
  malformed input (unclosed quotes/parens, non-ASCII bytes, bad escapes)
  are rejected with `ZoneParseError` — never silently skipped.

## Develop

```sh
npm install
npm test   # builds with tsc, runs node:test suites in test/
```
