# heartbeat-ranker

Time-weighted heartbeat metric ranking for dashboards.

Nodes report `cpu` / `memory` / `disk` (integers, hundredths of a percent) at
inconsistent rates. A heartbeat at time `t` holds its values over
`[t, min(next heartbeat, t + 300000ms))`; everything else is unknown and counts
neither toward the integral nor the coverage. Rankings use the time-weighted
mean (integral / coverage) over a trailing window; nodes with zero coverage in
the window are omitted. Ties on the exact unrounded mean break by ascending
`nodeId`. Windows and hold intervals are left-closed, right-open.

## Usage

```ts
import { HeartbeatRanker } from 'heartbeat-ranker';

const ranker = new HeartbeatRanker(['node-a', 'node-b'], Date.now());
ranker.ingest('node-a', 1_700_000_000_000, 5000, 2500, 9999); // out-of-order ok
ranker.advanceTo(Date.now());                                  // monotonic
const top = ranker.top(24, 'cpu'); // windows: 1, 6, 12, 24, 48, 72 hours
// => [{ nodeId, integral, coverageMs, mean }, ...] sorted by mean desc
```

## Develop

```sh
npm install
npm test   # tsc build + node:test (tests compare against a naive reference)
```
