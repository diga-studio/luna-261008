# task26100840

Heartbeat metric ranking library for dashboards (TypeScript).

Nodes report heartbeats at arbitrary rates. Rankings use a time-weighted
mean over effective online intervals: a heartbeat at time `t` holds its
metric values over `[t, min(nextHeartbeat, t + 300000ms))`; everything
else is unknown and counts neither toward the integral nor the coverage.

## API

```ts
import { HeartbeatRanker } from "heartbeat-ranker";

const ranker = new HeartbeatRanker(["node-a", "node-b"], Date.now());
ranker.ingest("node-a", tsMs, cpu, memory, disk); // integers, 1/100 percent
ranker.advanceTo(nowMs);                          // monotonic UTC ms clock
const top = ranker.top(24, "cpu");                // windows: 1/6/12/24/48/72h
```

`top(windowHours, metric)` returns `{ nodeId, integral, coverageMs, mean }[]`
sorted by the unrounded mean (`integral / coverageMs`) descending, ties by
`nodeId` ascending. Nodes with zero coverage in the window are omitted.
Windows and hold intervals are left-closed, right-open. Out-of-order
ingestion yields results identical to the time-sorted full history
(validated against `ReferenceRanker` in `src/reference.ts`).

## Develop

```sh
npm install
npm test   # compiles with tsc, then runs node --test
```
