# netseg-policy

Network segmentation policy library in TypeScript. Provides two entry points:

- `decide(config, profileId, deviceId, connection, minute)` — the final network
  permission (`vlan`, `allowedCIDRs`, `bandwidth`) for one context.
- `audit(config)` — for every rule, whether deleting that single rule (and only
  that rule) from the original config leaves every legal context's final
  permission unchanged.

## Model

- **AuthProfile** `{ id, role, method, trust }` — one legal
  (user, authentication method, trust) combination. Trust is fixed by the
  profile; combinations that do not exist as a profile never occur.
- **Segment** `{ id, vlan, allowedCIDRs, bandwidth }` — `vlan` in 1..4094,
  globally unique; `allowedCIDRs` already normalized.
- **Device** `{ id, supportedVlans, isolationSegmentId }` — the isolation
  VLAN is always supported.
- **Rule** `{ id, priority, segmentId, role, method, trust, connection, window }`
  — priorities are pairwise distinct, smaller wins. The four non-time
  conditions are single values or `'*'`. `window` is `[start, end)` in local
  minutes 0..1439, may wrap past midnight, `start === end` means all day.

`decide` picks the first matching rule. If the target VLAN is unsupported by
the device it returns the device's isolation segment immediately (later rules
are not tried); no matching rule also yields the isolation segment.

## Audit semantics

`audit` returns one `RuleAudit` per rule (in priority order):

```ts
{ ruleId, safeToRemove, witness? }
```

`safeToRemove` is true iff deleting exactly this rule from the original config
keeps `decide` identical on all three returned fields over the full context
domain (all profiles x all devices x both connection types x all 1440 minutes).
A change of the matched rule alone is not a permission change. Unsafe rules
carry a `witness` context plus `before`/`after` permissions reproducible with
`decide` on the original config and on the config without that rule.

### How it stays exact without enumerating the domain

- Profiles collapse to distinct `(role, method, trust)` triples; contexts are
  bitsets over `(triple, connection)`.
- Minutes collapse to atomic intervals bounded by rule window edges; identical
  active-rule sets are swept once.
- A single sweep per active set computes, for every context, its first and
  second matching rule — yielding every observed `(first, second)` pair.
- Device outcome equivalence between segment pairs is decided exactly from
  per-device VLAN support and isolation segments (a rule removal only matters
  where the first match changes to an outcome some device would see
  differently).

Complexity is roughly `O(atoms x rules x triples/32)` bit operations plus
`O(sum device-vlan pairs^2)` — no full Cartesian product, no per-rule replay.

## Develop

```sh
npm install
npm test        # type-checks, compiles, runs node:test suites
npm run build   # emits dist/
```

Only devDependency is `typescript`; tests run on the built-in Node test runner.
