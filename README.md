# OpsCentral Scheduler

Schedule expansion library for OpsCentral. It **only computes the UTC
instants at which schedules should fire** — it never executes workflows.

- All inputs and outputs are UTC millisecond timestamps.
- Rules are interpreted on the local calendar of their IANA time zone.
- Nonexistent local times (DST gaps) are skipped, never shifted.
- Repeated local times (DST overlaps) fire at both real UTC instants.
- Daily/weekly rules use local calendar semantics, not fixed durations.

## Rules

Each rule carries a `timeZone` (IANA name) and one period kind:

- `every15Minutes` — local minute 00, 15, 30, 45
- `hourly` — local minute 00
- `daily` — given local `hour`/`minute`
- `weekly` — given local `weekday` (Mon=1..Sun=7), `hour`, `minute`

All triggers have zero local seconds and milliseconds.

## API

```ts
import { nextOccurrences, pageDue } from "opscentral-scheduler";

// First `limit` trigger instants strictly after `after`, UTC ascending.
nextOccurrences(rule, after, limit);

// One page of due items across schedules in the half-open window
// (from, to], ordered by (at, scheduleId UTF-16 code units).
// Omit `cursor` first; feed back `nextCursor` until it is undefined.
// Concatenating all pages yields every occurrence exactly once, in
// order; `pageSize` may change between calls.
pageDue(schedules, from, to, pageSize, cursor?);
```

## Develop

```sh
npm install
npm test   # type-checks, builds to dist/, runs node:test suites
```

Requires only Node.js (18.17+) and the `typescript` devDependency.
