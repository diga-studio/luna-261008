import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGuard, FleetGuardStats } from '../src/fleetguard';
import { Policy } from '../src/types';
import { ReferenceFleetGuard } from './reference';

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

const PROFILE_COUNT = 20000;
const DEVICE_COUNT = 10000;
const SSIDS_PER_PROFILE = 64;
const SSID_POOL = 200000;

function makePolicy(rand: () => number, tag: number): Policy {
  const ssids = new Set<string>(['shared-a', 'shared-b']);
  while (ssids.size < SSIDS_PER_PROFILE) {
    ssids.add(`ssid-${Math.floor(rand() * SSID_POOL)}`);
  }
  return {
    minPinLength: 6 + (tag % 9),
    maxAutoLockSeconds: 30 + (tag % 200),
    allowCamera: tag % 7 !== 0,
    allowScreenshots: tag % 11 !== 0,
    allowedSsids: [...ssids],
  };
}

function snapshot(stats: FleetGuardStats): FleetGuardStats {
  return { ...stats };
}

function delta(before: FleetGuardStats, after: FleetGuardStats): FleetGuardStats {
  return {
    profileFolds: after.profileFolds - before.profileFolds,
    ssidEntryTouches: after.ssidEntryTouches - before.ssidEntryTouches,
    memberIterations: after.memberIterations - before.memberIterations,
  };
}

test('20k profiles / 10k devices: updates stay incremental, resolves never rescan', () => {
  const rand = mulberry32(99);
  const fg = new FleetGuard();
  const reference = new ReferenceFleetGuard();
  const group: { kind: 'group'; id: string } = { kind: 'group', id: 'shared' };

  // 2 万份配置绑定到共享组；1 万台设备加入该组。
  for (let i = 0; i < PROFILE_COUNT; i += 1) {
    const policy = makePolicy(rand, i);
    fg.putProfile(`p${i}`, policy);
    reference.putProfile(`p${i}`, policy);
  }
  fg.bindProfiles(
    group,
    Array.from({ length: PROFILE_COUNT }, (_, i) => `p${i}`),
    [],
  );
  reference.bindProfiles(
    group,
    Array.from({ length: PROFILE_COUNT }, (_, i) => `p${i}`),
    [],
  );
  const devices = Array.from({ length: DEVICE_COUNT }, (_, i) => `dev${i}`);
  for (const deviceId of devices) {
    fg.joinGroups(deviceId, ['shared'], []);
    reference.joinGroups(deviceId, ['shared'], []);
  }

  // 正确性：与参考模型逐份合并结果一致（抽样设备，组内所有设备结果相同）。
  const expectedPolicy = reference.resolve('dev0');
  assert.deepEqual(fg.resolve('dev0'), expectedPolicy);
  assert.deepEqual(fg.resolve(`dev${DEVICE_COUNT - 1}`), expectedPolicy);

  // 1) 整体替换一份配置：只允许折叠该配置（旧+新各一次）、触碰其自身 SSID。
  const replacement = makePolicy(rand, 12345);
  let before = snapshot(fg.stats);
  fg.putProfile('p777', replacement);
  reference.putProfile('p777', replacement);
  let d = delta(before, fg.stats);
  assert.equal(d.profileFolds, 2, 'replace folds exactly the old and new copy');
  assert.ok(
    d.ssidEntryTouches <= 2 * SSIDS_PER_PROFILE,
    `ssid touches ${d.ssidEntryTouches} <= ${2 * SSIDS_PER_PROFILE}`,
  );
  assert.equal(d.memberIterations, 0, 'no member device iteration on update');
  assert.deepEqual(fg.resolve('dev0'), reference.resolve('dev0'));

  // 2) 撤销一份配置的绑定：只允许折叠该配置一次。
  before = snapshot(fg.stats);
  fg.bindProfiles(group, [], ['p555']);
  reference.bindProfiles(group, [], ['p555']);
  d = delta(before, fg.stats);
  assert.equal(d.profileFolds, 1, 'unbind folds exactly the removed copy');
  assert.ok(d.ssidEntryTouches <= SSIDS_PER_PROFILE);
  assert.equal(d.memberIterations, 0);
  assert.deepEqual(fg.resolve('dev0'), reference.resolve('dev0'));

  // 3) 改写一份未绑定到任何目标的配置：零折叠。
  before = snapshot(fg.stats);
  fg.putProfile('p555', makePolicy(rand, 555));
  reference.putProfile('p555', makePolicy(rand, 555));
  d = delta(before, fg.stats);
  assert.equal(d.profileFolds, 0, 'unbound profile rewrite touches no aggregate');
  assert.equal(d.ssidEntryTouches, 0);
  assert.equal(d.memberIterations, 0);

  // 4) 读取全部 1 万台设备：resolve 不得折叠任何原始配置、不得触碰 SSID 条目。
  before = snapshot(fg.stats);
  const first = fg.resolve(devices[0] as string);
  for (const deviceId of devices) {
    assert.deepEqual(fg.resolve(deviceId), first);
  }
  d = delta(before, fg.stats);
  assert.equal(d.profileFolds, 0, 'resolve never rescans raw profiles');
  assert.equal(d.ssidEntryTouches, 0, 'resolve never walks SSID entries');
  assert.equal(d.memberIterations, 0);

  // 5) 组成员变化只动该设备自身：不折叠配置、不遍历其它成员。
  before = snapshot(fg.stats);
  fg.joinGroups('dev0', [], ['shared']);
  fg.joinGroups('dev0', ['shared'], []);
  d = delta(before, fg.stats);
  assert.equal(d.profileFolds, 0);
  assert.equal(d.ssidEntryTouches, 0);
  assert.equal(d.memberIterations, 0);
  assert.deepEqual(fg.resolve('dev0'), first);
});
