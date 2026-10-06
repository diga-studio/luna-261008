# org-tenure-planner

In-memory TypeScript library for planning effective-dated org reporting
lines, called directly by an upper-layer scenario planner.

- Fixed set of positions, each with a stable string id.
- Load an initial history that tiles the whole timeline exactly once.
- Apply batches of manager adjustments over `[start, end)` day ranges
  (`MM/DD/YYYY`, end exclusive, `null` end = infinite future).
- Reconstruct the full organization as of any calendar day.
- Dates are compared by calendar day via UTC arithmetic, independent of
  the host machine timezone.

## Semantics

- An adjustment replaces the manager only inside its interval; history
  outside is preserved exactly. Later batches override overlapping
  history without erasing the days before/after the overlap.
- Adjustments in one batch have no ordering semantics: validity is
  judged on the organization after all of them take effect together.
  Intervals of the same position within one batch must not overlap.
- A batch is atomic: it is rejected as a whole (stored history fully
  untouched) if any adjustment is malformed or the resulting
  organization has a reporting cycle on **any** day, past or future.
  A reports-to-B in January and B reports-to-A in February is legal as
  long as the two never form a cycle on the same day.

## API

```ts
import { OrgPlanner } from "org-tenure-planner";

const planner = new OrgPlanner(["CEO", "VP", "IC"]);
planner.loadHistory([
  { positionId: "CEO", managerId: null, start: null, end: null },
  { positionId: "VP",  managerId: "CEO", start: null, end: null },
  { positionId: "IC",  managerId: "VP",  start: null, end: null },
]);

const result = planner.applyBatch([
  { positionId: "IC", newManagerId: "CEO", start: "01/01/2026", end: "03/01/2026" },
]);
if (!result.accepted) console.warn(result.reason);

planner.getManager("IC", "02/01/2026"); // "CEO"
planner.getSnapshot("02/01/2026");      // { CEO: null, VP: "CEO", IC: "CEO" }
```

## Develop

```sh
npm install
npm test   # builds with tsc, then runs node --test
```
