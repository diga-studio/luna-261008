# log-alert-analyzer

In-memory TypeScript library that reports the maximal continuous time
intervals during which a service's sliding-window error rate stays strictly
above 5%. Data lives in the library instance; callers use it directly as a
library (no network, no storage services).

## API

```ts
import { LogAlertAnalyzer } from "log-alert-analyzer";

const analyzer = new LogAlertAnalyzer();

// Append a batch of request records (any order, late arrivals allowed).
analyzer.append([
  { timestampMs: 1_700_000_000_000, service: "api", statusCode: 500, traceId: "t-1" },
  { timestampMs: 1_700_000_000_100, service: "api", statusCode: 200, traceId: "t-2" },
]);

// Delete every request of a trace, across all services. Returns removed count.
analyzer.deleteByTraceId("t-1");

// Maximal anomalous intervals within [fromMs, toMs), clipped to the range.
analyzer.queryAnomalyIntervals("api", 1_700_000_000_000, 1_700_100_000_000);
// => [{ startMs: ..., endMs: ... }, ...]
```

## Semantics

- A record is one request: millisecond timestamp, service name, HTTP status
  code, trace id. A trace may span services and contain many requests; every
  request counts independently.
- Status 500-599 is an error, anything else is a success.
- The sliding window is fixed at 15 minutes: at time `t` it covers timestamps
  in `(t - 900000, t]`. A request enters at its timestamp and leaves 900000 ms
  later; entries and exits at the same millisecond jointly determine that
  millisecond's result.
- A time point is anomalous iff the window is non-empty and
  `errors / total > 5%` (computed in exact integer arithmetic as
  `20 * errors > total`; exactly 5% and empty windows are normal).
- Queries are `[from, to)`; results are maximal continuous `[start, end)`
  intervals with millisecond precision. Adjacent anomalous segments merge,
  intervals crossing the query boundary are clipped, and 1 ms anomalies are
  reported. No zero-length or artificially split intervals.
- Appends and deletions revise history: after every operation, queries match
  a from-scratch recomputation over the currently stored records, including
  the influence of records up to 15 minutes before the query range.

## Design

Per service, window-count changes are stored as events: `+1` at the request
timestamp, `-1` at timestamp + 15 min (same for the error counters). The
count profile between consecutive event times is constant, so anomaly
intervals are unions of event-delimited segments.

Events live in a sqrt-decomposed sorted block list (~1024 events per block).
Each block caches its total deltas and its maximum local value of
`20 * errors - total`, so:

- append/delete of one record: two point updates, `O(sqrt(n))` each;
- large batches: one merge-and-rechunk pass, `O(n + m)`;
- full-range anomaly query: `O(#blocks + #anomalous segments)` — blocks whose
  cached maximum cannot be anomalous are skipped without scanning.

Traces are indexed as `traceId -> record indices` into flat arenas
(timestamps and packed service/error metadata), keeping memory at roughly
150 MiB for 1M stored records.

## Performance and memory

Verified by `test/scale.test.ts` (seeded, repeatable): 1M records over 50
services and 90 days, including 300k records concentrated in a single 15
minute window, then 1000 rounds of <=10 appends/deletes (many landing in old
time ranges or inside the dense cluster) each followed by a full-90-day
anomaly query. Query results are cross-checked against an independent
from-scratch recount. Measured on an Apple Silicon MacBook:

- 1000 rounds: ~1.6 s (budget 10 s, each query returning <= 20 segments);
- peak RSS: ~600-630 MiB (budget 768 MiB).

The suite runs with `NODE_OPTIONS=--max-old-space-size=512` so V8 collects
garbage eagerly instead of reserving idle heap; the live data set is far
below the budget.

## Develop

```sh
npm install
npm test        # builds to dist/ and runs unit + scale tests
npm run build
```

Only Node.js (>= 18) is required; `typescript` and `@types/node` are the
sole dev dependencies.
