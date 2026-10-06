# SupplyPulse Replenishment Planner

Short-shelf-life raw material replenishment planning library (TypeScript).
Single material, single warehouse. The approved forecast is already
exploded into daily material demand; all quantities are non-negative
integers in one base unit. The library only decides purchasing — it never
alters production demand.

## Rules of the world

- Every batch (fixed supply or new purchase) has a fixed 3-day shelf life:
  usable on its arrival day and the next two days; it expires at the start
  of arrival day + 3.
- Each day: expired batches are removed first, then fixed supply and new
  purchases arriving that day are received, then the day's demand is
  satisfied FIFO (oldest arrival day first). Demand must be met in full on
  the day — no early deduction, no backorders.
- Fixed batches may arrive on day -2, -1 (initial stock) or inside the
  horizon (confirmed in-transit). They can never be cancelled or deferred.
- New purchases may only arrive on `allowedArrivalDays`; the order is
  placed on `arrivalDay - leadTime`, which must be >= 0. At most one order
  per arrival day; each order quantity is a positive multiple of
  `packSize` and at least `moq`.
- Leftover stock at the end of the horizon has no value.

## API

```ts
import { plan, replay } from "supplypulse-replenishment";

const result = plan(input);
// result.feasible === true  -> { orders, totalQuantity, orderCount }
// result.feasible === false -> no plan can satisfy every day's demand

const check = replay(input, result.orders);
// Recomputes consumption, expiry and balances day by day from the input
// batches and the given orders; validates order legality and reports
// feasibility independently of any planner output.
```

`plan` minimizes total purchased quantity first, then the number of
orders. It is an exact dynamic program over daily stock-age states
`(older, newer)` (leftovers that arrived 2 and 1 days ago), with exact
dominance pruning — no daily greedy, no plan-combination enumeration, no
input-independent purchase caps, and batch ages are tracked explicitly.

## Development

```sh
npm install
npm test   # builds with tsc, then runs node --test on dist/test
```

Tests cover the classic one-order-beats-daily-gap-filling case,
infeasibility through expiry and through lead time, an independent
exhaustive enumerator cross-checking feasibility and both objectives on
~1000 random small instances, and 60-day scale/stress instances.
