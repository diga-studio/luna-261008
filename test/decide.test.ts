import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decide';
import type { PolicyConfig, Rule } from '../src/types';

function makeConfig(rules: Rule[]): PolicyConfig {
  return {
    profiles: [
      { id: 'p1', role: 'admin', method: 'sso', trust: 'high' },
      { id: 'p2', role: 'admin', method: 'cert', trust: 'low' },
    ],
    segments: [
      { id: 's10', vlan: 10, allowedCIDRs: ['10.0.0.0/8'], bandwidth: 100 },
      { id: 's20', vlan: 20, allowedCIDRs: ['192.168.0.0/16'], bandwidth: 50 },
      { id: 'iso', vlan: 99, allowedCIDRs: [], bandwidth: 1 },
    ],
    devices: [
      { id: 'd-all', supportedVlans: [10, 20, 99], isolationSegmentId: 'iso' },
      { id: 'd-none', supportedVlans: [99], isolationSegmentId: 'iso' },
    ],
    rules,
  };
}

const base: Omit<Rule, 'id' | 'priority' | 'segmentId'> = {
  role: '*',
  method: '*',
  trust: '*',
  connection: '*',
  window: { start: 0, end: 0 },
};

test('first matching rule by priority wins', () => {
  const config = makeConfig([
    { ...base, id: 'r1', priority: 2, segmentId: 's20' },
    { ...base, id: 'r2', priority: 1, segmentId: 's10' },
  ]);
  const d = decide(config, 'p1', 'd-all', 'wired', 500);
  assert.equal(d.vlan, 10);
  assert.deepEqual(d.allowedCIDRs, ['10.0.0.0/8']);
  assert.equal(d.bandwidth, 100);
});

test('unsupported target vlan falls back to isolation immediately', () => {
  const config = makeConfig([
    { ...base, id: 'r1', priority: 1, segmentId: 's10' },
    { ...base, id: 'r2', priority: 2, segmentId: 's20' },
  ]);
  // d-none supports neither 10 nor 20: first match r1 -> isolation, r2 not tried.
  const d = decide(config, 'p1', 'd-none', 'wired', 500);
  assert.equal(d.vlan, 99);
});

test('no matching rule returns isolation segment', () => {
  const config = makeConfig([
    { ...base, id: 'r1', priority: 1, segmentId: 's10', role: 'guest' },
  ]);
  const d = decide(config, 'p1', 'd-all', 'wired', 500);
  assert.deepEqual(d, { vlan: 99, allowedCIDRs: [], bandwidth: 1 });
});

test('trust comes from the profile, not combined across profiles', () => {
  const config = makeConfig([
    { ...base, id: 'r1', priority: 1, segmentId: 's10', role: 'admin', method: 'sso', trust: 'low' },
    { ...base, id: 'r2', priority: 2, segmentId: 's20', role: 'admin', method: 'sso', trust: 'high' },
  ]);
  // p1 is (admin, sso, high): r1 requires trust low -> no match; r2 matches.
  const d = decide(config, 'p1', 'd-all', 'wired', 500);
  assert.equal(d.vlan, 20);
});

test('time window: left-closed right-open, wrap, all-day', () => {
  const config = makeConfig([
    { ...base, id: 'r1', priority: 1, segmentId: 's10', window: { start: 100, end: 200 } },
    { ...base, id: 'r2', priority: 2, segmentId: 's20', window: { start: 1300, end: 60 } },
  ]);
  assert.equal(decide(config, 'p1', 'd-all', 'wired', 100).vlan, 10); // left closed
  assert.equal(decide(config, 'p1', 'd-all', 'wired', 199).vlan, 10);
  assert.equal(decide(config, 'p1', 'd-all', 'wired', 200).vlan, 99); // right open
  assert.equal(decide(config, 'p1', 'd-all', 'wired', 1300).vlan, 20); // wrap start
  assert.equal(decide(config, 'p1', 'd-all', 'wired', 59).vlan, 20); // wrap end side
  assert.equal(decide(config, 'p1', 'd-all', 'wired', 60).vlan, 99);
  const allDay = makeConfig([{ ...base, id: 'r1', priority: 1, segmentId: 's10' }]);
  assert.equal(decide(allDay, 'p1', 'd-all', 'wired', 0).vlan, 10);
  assert.equal(decide(allDay, 'p1', 'd-all', 'wired', 1439).vlan, 10);
});

test('connection condition', () => {
  const config = makeConfig([
    { ...base, id: 'r1', priority: 1, segmentId: 's10', connection: 'wireless' },
  ]);
  assert.equal(decide(config, 'p1', 'd-all', 'wireless', 1).vlan, 10);
  assert.equal(decide(config, 'p1', 'd-all', 'wired', 1).vlan, 99);
});
