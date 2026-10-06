# pipeline-stage-report

TypeScript library that reports how long candidates dwell in each stage of a
single talent pipeline. All data lives in process memory; nothing is persisted.

## Stages

`Identified` → `Contacted` → `Engaged` → `Submitted to Client` →
`Interviewing` → `Placed` → `Alumni`

## Data model

A candidate's history is a list of `{ at, stage }` records (`at` is a UTC
epoch timestamp in integer milliseconds). A record means the candidate entered
`stage` at `at` and stays there until the next record; the last record is
open-ended, and time before the first record is not counted. Timestamps must
be strictly increasing and adjacent records must have different stages.
Re-entering a stage later starts a new dwell segment.

## API

```ts
import { PipelineStore, generateReport, WINDOW_MS } from "pipeline-stage-report";

const store = new PipelineStore();

// Append/merge history for one candidate (validated against existing records).
store.submitHistory("cand-1", [
  { at: Date.UTC(2026, 0, 1), stage: "Contacted" },
  { at: Date.UTC(2026, 0, 15), stage: "Engaged" },
]);

// Backfill / correction: fully replaces the candidate's history.
// After a successful call, reports reflect only the new history.
store.replaceHistory("cand-1", [{ at: Date.UTC(2026, 0, 1), stage: "Engaged" }]);

// Report over [asOf - 90 days, asOf), left-closed right-open.
const report = generateReport(store, Date.UTC(2026, 3, 1));
// report["Contacted"] === { segments, totalMs, averageMs }
```

For each stage the report contains the number of dwell segments overlapping
the window, their total overlapped duration in milliseconds, and the average
(`totalMs / segments`, `0` when there are no segments). One candidate may
contribute several segments to the same stage. Open-ended (still current)
segments follow the same rules as finished ones. Segments that end exactly at
the window's left edge or start exactly at its right edge are not counted.

Invalid input (non-integer timestamps, non-increasing times, equal adjacent
stages, unknown stage) is rejected and leaves previously stored data
untouched.

## Develop

```sh
npm install
npm test        # builds to dist/ and runs the node:test suite
npm run build   # compile only
```

Requires Node.js 18+ and the dev dependencies in `package.json`
(`typescript`, `@types/node`); no other services are needed.
