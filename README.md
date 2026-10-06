# org-validity-planner

In-memory TypeScript library for planning effective-dated org reporting
lines. Designed to be called directly by an upper-layer scenario planner.

## Features

- Fixed set of positions, each with a stable string id.
- Load initial history once: every position must be covered for all dates,
  and the history must be free of reporting cycles on every day.
- Apply adjustments in atomic batches. Each adjustment sets one position's
  manager (or `null` for "no manager") over `[startDate, endDate)`;
  `endDate: null` means the infinite future.
- Adjustments replace only their own range; history outside is preserved.
  Later batches override overlapping history without erasing the edges.
- A batch is validated against the organization produced by ALL of its
  adjustments together: every single day must be free of reporting cycles.
  Invalid batches are rejected as a whole and change nothing.
- Query the manager of any position on any day, or restore the whole
  organization for a day via `getOrgSnapshot`.
- Dates are `MM/DD/YYYY` strings compared by calendar day with pure integer
  arithmetic — results never depend on the host machine's timezone.

## Usage

```ts
import { OrgPlanner } from "./src/index.js";

const planner = new OrgPlanner(["ceo", "eng", "sales"]);

planner.loadInitialHistory([
  { positionId: "ceo", managerId: null, startDate: "01/01/2020", endDate: null },
  { positionId: "eng", managerId: "ceo", startDate: "01/01/2020", endDate: null },
  { positionId: "sales", managerId: null, startDate: "01/01/2020", endDate: null },
]);

// Swap ceo and eng from 03/01/2025 on. Legal because the batch as a whole
// stays acyclic, even though each adjustment alone would form a 2-cycle.
planner.applyBatch([
  { positionId: "ceo", managerId: "eng", startDate: "03/01/2025", endDate: null },
  { positionId: "eng", managerId: null, startDate: "03/01/2025", endDate: null },
]);

planner.getManagerAt("ceo", "03/15/2025"); // "eng"
planner.getOrgSnapshot("03/15/2025");      // { ceo: "eng", eng: null, sales: null }
```

## Develop

```sh
npm install
npm test
```

`npm test` compiles the TypeScript sources and runs the `node:test` suite.
No services, databases or Docker required; everything lives in memory.
