# secure-audit-log

Tamper-evident security event audit log library (TypeScript), persisted in
SQLite. Provides four capabilities for upper-layer callers — no service
layer included:

1. **Append** — `AuditLog.append(timestampMs, before, after)`
2. **Seal** — `AuditLog.seal()` returns a credential committing to all
   records and their order, including the total count
3. **Export** — `AuditLog.export(window, credential)` builds a time-window
   package with cryptographic proofs
4. **Verify** — `verifyExport(pkg, window, credential)` independently
   verifies a package using only the package, the caller's query window,
   and the trusted seal credential (no database access)

## Requirements

- Node.js >= 23.4 (uses the built-in `node:sqlite` module; no native or
  external dependencies)

```
npm install
npm test
```

## Data model

- Each record holds an integer millisecond timestamp and two UTF-8 texts
  (state before / after the operation). Timestamps are non-decreasing in
  append order; equal timestamps are allowed.
- The module assigns consecutive sequence numbers starting at 1.
- Records live in a single append-only SQLite table.

## Security model

- A seal credential `{ count, root }` is the Merkle root (RFC 6962-style,
  SHA-256, domain-separated) over all records at seal time. The caller
  keeps it safe outside the module; a credential carried inside an export
  package is **not** a trusted source.
- After sealing, an attacker may rewrite the database or the export
  package arbitrarily, but cannot replace the caller's credential. Under
  this model, any tampering — modifying fields, dropping, duplicating,
  reordering records, or disguising a non-empty window as empty — is
  detected with cryptographic (SHA-256 collision-resistance) strength.
- The module enforces non-decreasing timestamps at append time; the
  verifier relies on this invariant holding for the sealed prefix.

## Export packages

Windows are left-closed, right-open `[startMs, endMs)`. Because timestamps
are non-decreasing, hits form a contiguous sequence range. A package
contains:

- every hit record in full (seq, timestamp, before, after) with a Merkle
  inclusion proof,
- the immediate left/right neighbours of the hit range as
  `(seq, timestamp, leafHash)` plus inclusion proofs — their before/after
  content is never revealed,
- for empty results, adjacent boundary records (or a first/last-record
  boundary, or nothing for an empty seal) proving no record falls in the
  window.

Verification checks the caller-supplied window and credential (not the
package's self-declared ones), authenticates every revealed leaf against
the sealed root, and enforces hit consecutiveness, window membership, and
boundary adjacency.

## Usage

```ts
import { AuditLog, verifyExport } from "secure-audit-log";

const log = new AuditLog("audit.db");
log.append(Date.now(), "state before", "state after");
const credential = log.seal(); // keep this safe, outside the module

const pkg = log.export({ startMs: t0, endMs: t1 }, credential);
const records = verifyExport(pkg, { startMs: t0, endMs: t1 }, credential);

log.close();
```

Reopening the database keeps existing credentials valid; appending and
exporting (against old prefixes or new seals) continue to work.
