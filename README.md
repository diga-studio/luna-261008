# TalentBridge

Offline, bidirectional job–candidate matching library. The caller supplies
jobs, candidates, and zip-code coordinates (parsed from local files); the
library returns exact top-25 recommendations in both directions using one
shared scoring rule.

## Install, build, test

```sh
npm install
npm run build   # compile src/ -> dist/ (library entry: dist/index.js)
npm test        # compile + run unit, acceptance, and performance tests
```

Requires only Node.js (18+) and the dev dependencies in `package.json`.
No services, databases, or network access are needed at runtime.

## API

```ts
import { TalentBridge } from 'talentbridge';

const tb = new TalentBridge();
tb.load({
  jobs,        // Job[]:        { id, zip, skills (<=15), slots (non-empty, 0..13) }
  candidates,  // Candidate[]:  { id, zip, skills (<=20), slots (0..13), maxCommuteMiles (5..50, step 5) }
  zipCodes,    // Record<string, { lat, lon }> — centroid per zip, in degrees
});

tb.recommendJobs('candidate-id');       // -> [{ jobId, score }, ...] up to 25
tb.recommendCandidates('job-id');       // -> [{ candidateId, score }, ...] up to 25
tb.recommendJobs('candidate-id', 10);   // custom limit
```

After `load` returns, the dataset is immutable for the life of the instance;
call `load` again (or create a new instance) to replace it. Repeated queries
on identical input return identical ordering.

## Matching rules

- **Distance**: great-circle distance between zip centroids on a sphere of
  radius 3958.7613 miles, compared at full precision (no rounding). Pairs
  farther than the candidate's radius are excluded; pairs exactly on the
  boundary are included. The 180th meridian is handled as the short way.
- **Skill ratio**: shared skills / job's required skills (1 if the job
  requires none). **Commute ratio**: 1 - distance / candidate radius.
  **Time ratio**: shared slots / job's required slots (14 AM/PM slots/week).
  Zero skill or time ratio does not exclude a pair.
- **Score**: `50 * skillRatio + 30 * commuteRatio + 20 * timeRatio`, rounded
  to 6 decimal places. Both directions use the same pair score and always
  the candidate's own radius.
- **Ranking**: rounded score descending, ties broken by the recommended
  object's id in ascending ASCII order; top 25 returned. Ranking is exact —
  spatial indexing only prunes pairs that cannot qualify, never approximates.

## Performance

Verified by `tests/perf.test.ts` on a dataset of 100,000 jobs and 50,000
candidates (common skills covering > 50% of jobs, one zip clustering > 10,000
jobs, plus an antimeridian zip pair):

- load well under 30 s (observed ~0.2 s)
- 1,000 mixed-direction queries well under 10 s (observed ~1.7 s)
- peak RSS under 512 MiB (observed ~375 MiB including the test harness)

## Layout

- `src/types.ts` — public input/output types
- `src/geo.ts` — haversine distance (R = 3958.7613 mi)
- `src/scoring.ts` — ratios, composite score, 6-decimal rounding
- `src/engine.ts` — load, spatial grid index, exact top-N queries
- `tests/` — unit tests, acceptance scenarios, performance test
