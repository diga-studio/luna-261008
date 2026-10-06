# talent-pipeline-stage-report

In-memory TypeScript library reporting how long candidates stay in each stage
of a single talent pipeline.

## Stages

`Identified` → `Contacted` → `Engaged` → `Submitted to Client` →
`Interviewing` → `Placed` → `Alumni` (fixed set, exported as `STAGES`).

## Usage

```ts
import { TalentPipeline } from "talent-pipeline-stage-report";

const pipeline = new TalentPipeline(); // 90-day report window by default

// Submit a candidate's stage history (UTC epoch ms, strictly increasing,
// adjacent stages must differ). A record means "entered this stage at this
// instant"; the last record is still in effect.
pipeline.submitHistory("candidate-1", [
  { atMs: 1_700_000_000_000, stage: "Identified" },
  { atMs: 1_700_100_000_000, stage: "Contacted" },
]);

// Correct or back-fill: the new history fully replaces the old one.
pipeline.replaceHistory("candidate-1", [
  { atMs: 1_700_000_000_000, stage: "Identified" },
  { atMs: 1_700_050_000_000, stage: "Engaged" },
]);

// Report over [asOfMs - 90d, asOfMs), left-closed right-open.
// Segments are clipped to the window; zero-overlap segments are ignored;
// re-entering a stage starts a new segment; an ongoing last segment counts.
const report = pipeline.report(1_700_200_000_000);
// report.entries: one per stage, in fixed order, each with
// segmentCount, totalDurationMs (exact ms), averageDurationMs (total/count, 0 when none).
```

Data lives in process memory only; nothing is persisted.

## Develop

```sh
npm install
npm test   # compiles with tsc and runs node:test suites
```
