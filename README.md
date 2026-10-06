# okr-health-score

TypeScript library that computes OKR health scores (velocity / frequency /
trend) for dashboards and historical reports. Callers supply the full
read-only history; all computed state lives in memory.

## Install & test

```sh
npm install
npm test
```

Requires only Node.js (18+). `npm test` compiles with TypeScript and runs
the node:test suite, including a batch workload of 1M history records and
50k objective queries cross-checked against an independent reference.

## Usage

```ts
import { OkrHealthScorer } from "okr-health-score";

const scorer = new OkrHealthScorer({
  objectives: [
    {
      id: "obj-1",
      start: 1_700_000_000,            // UTC seconds
      end: 1_700_000_000 + 90 * 86400, // period >= 28 days
      krs: [
        { id: "kr-1", weight: 60, progressKind: "percentage" },
        { id: "kr-2", weight: 40, progressKind: "numeric", targetValue: 200 },
      ],
    },
  ],
  checkIns: [{ krId: "kr-1", time: 1_700_100_000, value: 42 }],
  confidenceRecords: [{ krId: "kr-1", time: 1_700_100_000, confidence: 7 }],
});

const score = scorer.scoreObjective("obj-1", 1_700_000_000 + 40 * 86400);
// => { objectiveId, time, velocity, frequency, trend, health, krs: [...] }
```

## Scoring rules

- All times are UTC seconds; a day is exactly 86400 seconds. A query at
  time `T` uses the fixed 28-day window `[T - 28d, T]` and never looks at
  later records. `T` must be at least 28 days after the objective start
  and at most the objective end (inclusive).
- Progress and confidence are last-value-held: the latest record at or
  before the time in question applies (defaults: progress `0`,
  confidence `5.5`). Check-in values normalize to `[0, 1]`
  (percentage /100, numeric /targetValue, binary 0 or 1) and may regress.
- **Velocity** = progress gained over the window, scaled by
  `periodDays / 28`, clamped to `[0, 1]`.
- **Frequency** = share of the four consecutive 7-day slots
  (left-inclusive, right-exclusive) containing at least one check-in.
- **Trend** = `0.5 + 28b / 18` clamped to `[0, 1]`, where `b` is the
  slope (points/day) of a continuous-time least-squares line fitted to
  the held-confidence curve, with squared error integrated over time.
- **KR health** = `0.4 * velocity + 0.3 * frequency + 0.3 * trend`;
  objective health is the KR-weighted sum. No display rounding is applied.

## Performance

Preparation sorts and indexes the history once (per-KR check-in arrays
plus Kahan-compensated prefix integrals of the confidence step curve).
Each query then costs a few binary searches per KR. Measured: 1M records
prepared and 50k objective queries answered in well under 1 second on a
modern laptop (budget: 10 seconds), with results within 1e-8 of an
independent segment-by-segment reference.
