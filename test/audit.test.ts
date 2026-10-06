import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../src/audit';
import { decide } from '../src/decide';
import type {
  Connection,
  Decision,
  PolicyConfig,
  Rule,
  RuleAudit,
} from '../src/types';

const CONNS: Connection[] = ['wired', 'wireless'];

function decisionsEqual(a: Decision, b: Decision): boolean {
  return (
    a.vlan === b.vlan &&
    a.bandwidth === b.bandwidth &&
    a.allowedCIDRs.length === b.allowedCIDRs.length &&
    a.allowedCIDRs.every((c, i) => c === b.allowedCIDRs[i])
  );
}

/** Exhaustive oracle: checks every context of the full domain. */
function bruteForceSafe(config: PolicyConfig, ruleId: string): boolean {
  const reduced: PolicyConfig = {
    ...config,
    rules: config.rules.filter((r) => r.id !== ruleId),
  };
  for (const p of config.profiles) {
    for (const d of config.devices) {
      for (const c of CONNS) {
        for (let m = 0; m < 1440; m++) {
          const before = decide(config, p.id, d.id, c, m);
          const after = decide(reduced, p.id, d.id, c, m);
          if (!decisionsEqual(before, after)) return false;
        }
      }
    }
  }
  return true;
}

function assertAuditMatchesOracle(config: PolicyConfig): RuleAudit[] {
  const results = audit(config);
  assert.equal(results.length, config.rules.length);
  const byId = new Map(results.map((r) => [r.ruleId, r]));
  for (const rule of config.rules) {
    const ra = byId.get(rule.id);
    assert.ok(ra, `missing audit result for ${rule.id}`);
    const expected = bruteForceSafe(config, rule.id);
    assert.equal(
      ra!.safeToRemove,
      expected,
      `rule ${rule.id}: audit=${ra!.safeToRemove} oracle=${expected}`,
    );
    if (!expected) {
      const w = ra!.witness;
      assert.ok(w, `rule ${rule.id}: unsafe but no witness`);
      const before = decide(config, w!.profileId, w!.deviceId, w!.connection, w!.minute);
      const reduced: PolicyConfig = {
        ...config,
        rules: config.rules.filter((r) => r.id !== rule.id),
      };
      const after = decide(reduced, w!.profileId, w!.deviceId, w!.connection, w!.minute);
      assert.deepEqual(w!.before, before, `rule ${rule.id}: witness.before not reproducible`);
      assert.deepEqual(w!.after, after, `rule ${rule.id}: witness.after not reproducible`);
      assert.ok(
        !decisionsEqual(before, after),
        `rule ${rule.id}: witness shows no permission change`,
      );
    } else {
      assert.equal(ra!.witness, undefined, `rule ${rule.id}: safe but has witness`);
    }
  }
  return results;
}

function seg(vlan: number, id?: string) {
  return {
    id: id ?? `s${vlan}`,
    vlan,
    allowedCIDRs: [`10.${vlan}.0.0/16`],
    bandwidth: vlan * 10,
  };
}

const ISO = { id: 'iso', vlan: 99, allowedCIDRs: [] as string[], bandwidth: 1 };

function rule(id: string, priority: number, segmentId: string, extra?: Partial<Rule>): Rule {
  return {
    id,
    priority,
    segmentId,
    role: '*',
    method: '*',
    trust: '*',
    connection: '*',
    window: { start: 0, end: 0 },
    ...extra,
  };
}

test('joint shadow: two windows together cover the third rule, none alone does', () => {
  const config: PolicyConfig = {
    profiles: [{ id: 'p1', role: 'a', method: 'm', trust: 't' }],
    segments: [seg(10), ISO],
    devices: [{ id: 'd1', supportedVlans: [10, 99], isolationSegmentId: 'iso' }],
    rules: [
      rule('r1', 1, 's10', { window: { start: 0, end: 720 } }),
      rule('r2', 2, 's10', { window: { start: 720, end: 0 } }),
      rule('r3', 3, 's10'), // all-day, fully shadowed only by r1+r2 together
    ],
  };
  const results = assertAuditMatchesOracle(config);
  for (const r of results) assert.ok(r.safeToRemove, `${r.ruleId} should be safe`);
});

test('one-minute gap at the seam exposes the third rule', () => {
  const config: PolicyConfig = {
    profiles: [{ id: 'p1', role: 'a', method: 'm', trust: 't' }],
    segments: [seg(10), seg(20), ISO],
    devices: [{ id: 'd1', supportedVlans: [10, 20, 99], isolationSegmentId: 'iso' }],
    rules: [
      rule('r1', 1, 's10', { window: { start: 0, end: 720 } }),
      rule('r2', 2, 's10', { window: { start: 721, end: 0 } }), // minute 720 uncovered
      rule('r3', 3, 's20'),
    ],
  };
  const results = assertAuditMatchesOracle(config);
  const byId = new Map(results.map((r) => [r.ruleId, r]));
  const r3 = byId.get('r3')!;
  assert.ok(!r3.safeToRemove);
  assert.equal(r3.witness!.minute, 720); // the exact gap minute
  assert.equal(r3.witness!.before.vlan, 20);
  assert.equal(r3.witness!.after.vlan, 99); // isolation after removal
  assert.ok(!byId.get('r1')!.safeToRemove);
  assert.ok(!byId.get('r2')!.safeToRemove);
});

test('first-hit changes but all devices fall back to the same isolation: safe', () => {
  const mk = (extraDevice?: { id: string; supportedVlans: number[] }): PolicyConfig => ({
    profiles: [{ id: 'p1', role: 'a', method: 'm', trust: 't' }],
    segments: [seg(10), seg(20), ISO],
    devices: [
      { id: 'd0', supportedVlans: [99], isolationSegmentId: 'iso' },
      ...(extraDevice
        ? [{ ...extraDevice, isolationSegmentId: 'iso' }]
        : []),
    ],
    rules: [rule('r1', 1, 's10'), rule('r2', 2, 's20')],
  });
  const before = assertAuditMatchesOracle(mk());
  assert.ok(before.find((r) => r.ruleId === 'r1')!.safeToRemove);
  assert.ok(before.find((r) => r.ruleId === 'r2')!.safeToRemove);

  const after = assertAuditMatchesOracle(
    mk({ id: 'd1', supportedVlans: [10, 99] }),
  );
  assert.ok(!after.find((r) => r.ruleId === 'r1')!.safeToRemove);
  // r2 is never first-hit (r1 shadows it everywhere), so it stays safe.
  assert.ok(after.find((r) => r.ruleId === 'r2')!.safeToRemove);
});

test('identical twins: each safe alone, removing both changes authorization', () => {
  const config: PolicyConfig = {
    profiles: [
      { id: 'p1', role: 'staff', method: 'sso', trust: 'high' },
      { id: 'p2', role: 'staff', method: 'cert', trust: 'low' },
    ],
    segments: [seg(10), ISO],
    devices: [{ id: 'd1', supportedVlans: [10, 99], isolationSegmentId: 'iso' }],
    rules: [rule('r1', 1, 's10'), rule('r2', 2, 's10')],
  };
  const results = assertAuditMatchesOracle(config);
  assert.ok(results.every((r) => r.safeToRemove));
  // But deleting both at once flips the decision to isolation.
  const stripped: PolicyConfig = { ...config, rules: [] };
  assert.equal(decide(config, 'p1', 'd1', 'wired', 3).vlan, 10);
  assert.equal(decide(stripped, 'p1', 'd1', 'wired', 3).vlan, 99);
});

test('trust stays bound to its own profile during audit', () => {
  const config: PolicyConfig = {
    profiles: [
      { id: 'p-high', role: 'staff', method: 'sso', trust: 'high' },
      { id: 'p-low', role: 'staff', method: 'sso', trust: 'low' },
    ],
    segments: [seg(10), seg(20), ISO],
    devices: [{ id: 'd1', supportedVlans: [10, 20, 99], isolationSegmentId: 'iso' }],
    rules: [
      rule('r1', 1, 's10', { trust: 'high' }),
      rule('r2', 2, 's20'),
    ],
  };
  const results = assertAuditMatchesOracle(config);
  const r1 = results.find((r) => r.ruleId === 'r1')!;
  assert.ok(!r1.safeToRemove);
  assert.equal(r1.witness!.profileId, 'p-high'); // only the high-trust profile is affected
});

// ---- randomized differential test against the exhaustive oracle ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomConfig(rand: () => number): PolicyConfig {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const maybeWildcard = <T>(arr: T[]): T | '*' =>
    rand() < 0.4 ? '*' : pick(arr);
  const roles = ['r-a', 'r-b'];
  const methods = ['m-a', 'm-b'];
  const trusts = ['t-a', 't-b'];
  const profiles = Array.from({ length: 4 }, (_, i) => ({
    id: `p${i}`,
    role: pick(roles),
    method: pick(methods),
    trust: pick(trusts),
  }));
  const segments = [seg(10), seg(20), seg(30), ISO];
  const vlanPool = [10, 20, 30, 99];
  const devices = Array.from({ length: 3 }, (_, i) => ({
    id: `d${i}`,
    supportedVlans: [...new Set([99, ...vlanPool.filter(() => rand() < 0.5)])],
    isolationSegmentId: 'iso',
  }));
  const priorities = [1, 2, 3, 4, 5, 6];
  for (let i = priorities.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [priorities[i], priorities[j]] = [priorities[j]!, priorities[i]!];
  }
  const rules: Rule[] = Array.from({ length: 6 }, (_, i) => {
    const allDay = rand() < 0.25;
    return rule(`rule${i}`, priorities[i]!, pick(['s10', 's20', 's30']), {
      role: maybeWildcard(roles),
      method: maybeWildcard(methods),
      trust: maybeWildcard(trusts),
      connection: maybeWildcard(CONNS) as Rule['connection'],
      window: allDay
        ? { start: 0, end: 0 }
        : { start: Math.floor(rand() * 1440), end: Math.floor(rand() * 1440) },
    });
  });
  return { profiles, segments, devices, rules };
}

test('fuzz: audit agrees with exhaustive oracle on random configs', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const config = randomConfig(mulberry32(seed));
    assertAuditMatchesOracle(config);
  }
});
