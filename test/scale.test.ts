import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit } from '../src/audit';
import { decide } from '../src/decide';
import type { Decision, PolicyConfig, Rule } from '../src/types';

function decisionsEqual(a: Decision, b: Decision): boolean {
  return (
    a.vlan === b.vlan &&
    a.bandwidth === b.bandwidth &&
    a.allowedCIDRs.length === b.allowedCIDRs.length &&
    a.allowedCIDRs.every((c, i) => c === b.allowedCIDRs[i])
  );
}

/** Full-scale config: 50000 profiles (500 users x 10 methods x 10 trusts),
 *  10000 devices, 200 rules, exactly 200000 supported-VLAN entries. */
function makeScaleConfig(): PolicyConfig {
  const segments = [
    ...Array.from({ length: 200 }, (_, i) => ({
      id: `seg${i + 1}`,
      vlan: i + 1,
      allowedCIDRs: [`10.${i % 256}.${(i * 7) % 256}.0/24`],
      bandwidth: 100 + i,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `iso${i}`,
      vlan: 4001 + i,
      allowedCIDRs: [] as string[],
      bandwidth: 1,
    })),
  ];

  // Same user (role) authenticating via multiple methods, with trust levels
  // that differ per (method, user) combination.
  const profiles = [];
  for (let u = 0; u < 500; u++) {
    for (let m = 0; m < 10; m++) {
      for (let t = 0; t < 10; t++) {
        profiles.push({
          id: `p-${u}-${m}-${t}`,
          role: `user${u}`,
          method: `method${m}`,
          trust: (u + m) % 3 === 0 ? `trust${t}` : `trust${(t + m) % 10}`,
        });
      }
    }
  }

  const devices = Array.from({ length: 10000 }, (_, i) => {
    const isoIdx = i % 4;
    const supported = new Set<number>([4001 + isoIdx]);
    for (let k = 0; k < 19; k++) supported.add(((i * 13 + k * 17) % 200) + 1);
    while (supported.size < 20) supported.add((supported.size % 200) + 1);
    return {
      id: `dev${i}`,
      supportedVlans: [...supported],
      isolationSegmentId: `iso${isoIdx}`,
    };
  });

  const rules: Rule[] = Array.from({ length: 200 }, (_, i) => ({
    id: `rule${i}`,
    priority: i + 1,
    segmentId: `seg${(i * 37) % 200 + 1}`,
    role: i % 3 === 0 ? '*' : `user${(i * 7) % 500}`,
    method: i % 4 === 0 ? '*' : `method${(i * 3) % 10}`,
    trust: i % 5 === 0 ? '*' : `trust${(i * 11) % 10}`,
    connection: i % 3 === 0 ? '*' : i % 3 === 1 ? 'wired' : 'wireless',
    window:
      i % 4 === 0
        ? { start: 0, end: 0 }
        : { start: (i * 90) % 1440, end: (i * 90 + 480) % 1440 },
  }));

  return { profiles, segments, devices, rules };
}

test('audit runs at full scale and every witness reproduces', () => {
  const config = makeScaleConfig();
  assert.equal(config.profiles.length, 50000);
  assert.equal(config.devices.length, 10000);
  assert.equal(config.rules.length, 200);
  const totalSupported = config.devices.reduce((n, d) => n + d.supportedVlans.length, 0);
  assert.ok(totalSupported <= 200000, `supported vlan entries: ${totalSupported}`);

  const rulesRef = config.rules;
  const start = Date.now();
  const results = audit(config);
  const elapsed = Date.now() - start;
  console.log(`audit at scale: ${elapsed}ms`);

  // audit must not mutate the configuration
  assert.equal(config.rules, rulesRef);
  assert.equal(config.rules.length, 200);

  assert.equal(results.length, 200);
  let safe = 0;
  let unsafe = 0;
  for (const r of results) {
    if (r.safeToRemove) {
      safe++;
      assert.equal(r.witness, undefined);
      continue;
    }
    unsafe++;
    const w = r.witness!;
    const before = decide(config, w.profileId, w.deviceId, w.connection, w.minute);
    const reduced: PolicyConfig = {
      ...config,
      rules: config.rules.filter((x) => x.id !== r.ruleId),
    };
    const after = decide(reduced, w.profileId, w.deviceId, w.connection, w.minute);
    assert.deepEqual(w.before, before, `${r.ruleId}: witness.before`);
    assert.deepEqual(w.after, after, `${r.ruleId}: witness.after`);
    assert.ok(!decisionsEqual(before, after), `${r.ruleId}: witness must change permission`);
  }
  console.log(`safe=${safe} unsafe=${unsafe}`);
  assert.ok(safe > 0 && unsafe > 0, 'expected a mix of safe and unsafe rules');
});
