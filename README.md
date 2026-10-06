# AudienceNexus

In-process audience segmentation library for TypeScript/Node.js. It keeps a
store of user profiles, evaluates nested AND/OR segment rules, and maintains
**exact** member counts and **exact** pairwise intersections at all times.

All operations are synchronous and must be called sequentially. No
persistence, no concurrency, no failure recovery.

## Getting started

```sh
npm install
npm test        # builds with tsc, then runs the test suite
npm run build   # compile only (output in dist/)
```

Only devDependency is `typescript`; tests use the built-in `node:test`
runner, so a clean machine with just Node.js + npm is enough.

## API

```ts
import { AudienceNexus } from 'audience-nexus';

const engine = new AudienceNexus();

engine.upsertBatch([
  { userId: 'u1', engagementScore: 80, region: 'cn', purchaseTags: ['vip'] },
  { userId: 'u2', engagementScore: null, region: null, purchaseTags: [] },
]);

engine.saveSegment('active-cn', {
  type: 'and',
  children: [
    { type: 'scoreRange', min: 50, max: 100 },
    { type: 'or', children: [{ type: 'region', value: 'cn' }, { type: 'tag', value: 'vip' }] },
  ],
});

engine.stats('active-cn');                 // { count }
engine.stats('active-cn', 'other');        // { countA, countB, intersection }
```

- `upsertBatch(records)` — inserts or fully replaces profiles by `userId`.
  The last record wins for duplicate ids within one batch. Replacement may
  remove tags or set fields to `null`.
- `saveSegment(segmentId, rule)` — creates or replaces a segment definition
  and immediately stores its exact member count. Replacing one segment never
  affects others.
- `stats(segmentId)` / `stats(segmentId, otherSegmentId)` — exact counts and
  exact intersection (distinct users matching both rule trees). A segment's
  intersection with itself equals its own count. Unknown ids throw.

### Rules

Group nodes are `and` / `or` with non-empty `children`; the root group is
level 1 and trees are at most 3 levels deep with at most 16 leaves. Leaves:

- `{ type: 'scoreRange', min, max }` — closed interval on `engagementScore`
  (integer 0–100); `null` score makes the leaf false.
- `{ type: 'region', value }` — region equality; `null` region is false.
- `{ type: 'tag', value }` — `purchaseTags` contains the tag.

Duplicate leaves and overlapping OR branches are legal; each profile counts
at most once per segment.

## How it works

- Each profile gets a dense integer id. Regions and tags are kept in inverted
  indexes (posting lists); scores are kept in 101 prefix bitsets
  (`scoreLe[k]` = users with a non-null score `<= k`).
- `saveSegment` evaluates the rule tree purely with bitset algebra over
  those indexes — it never scans profile records.
- `upsertBatch` re-evaluates only the profiles that actually changed in the
  batch (after in-batch dedup) against compiled segment matchers and flips
  membership bits incrementally, so every stored count stays exact.
- `stats` intersections are bitset AND + popcount over stored member sets.
- Posting lists are adaptive: sparse lists are sorted arrays, dense lists
  (e.g. a tag on 90% of profiles) are promoted to bitsets, keeping both
  updates and snapshots cheap. Segment matchers compile to a flat jump
  program interpreted by one shared VM, so thousands of segments do not
  create thousands of JIT-compiled functions.

## Tests

- `test/random.test.ts` — randomized differential testing against an
  independent per-profile reference evaluator: duplicate ids in a batch, tag
  removal, null replacement, score boundaries, rule replacement, duplicated
  OR branches; verifies all counts and sampled intersections after every op.
- `test/intersection.test.ts` — two segments sharing part of their rules;
  one batch causes profiles to enter, leave, and stay in the intersection;
  counts and intersection are checked to change in lockstep.
- `test/stress.test.ts` — 100k profiles, 2,000 segments, 20k regions, 50k
  tags; full load, saving all segments, 100 batches x 128 updates and 2,000
  interleaved pair queries. Verifies independently computable wide/narrow
  segments and their intersection (no full reference evaluation), and
  asserts the run stays under 60 s and 384 MiB peak RSS while printing
  timings and peak memory.
