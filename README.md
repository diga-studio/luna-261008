# dns-message-parser

Strict DNS message parser (TypeScript) for edge protection engines. Input is a
single DNS message without any transport-layer framing.

## Usage

```ts
import { parseMessage, DnsParseError } from "dns-message-parser";

const message = parseMessage(bytes); // throws DnsParseError on any structural error
```

`parseMessage` parses the header, question section, and the answer / authority
/ additional resource-record sections. Domain names are returned as arrays of
label byte arrays (case and arbitrary octets preserved); the root name is `[]`.

Name compression is validated strictly: pointers may only target label starts,
pointer first bytes, or root terminators of names that were already fully
parsed earlier in the message. CNAME (type 5) and SOA (type 6) RDATA are
parsed structurally; all other RDATA is kept as opaque bytes.

## Develop

```sh
npm install
npm test   # builds with tsc, then runs node:test suites
```
