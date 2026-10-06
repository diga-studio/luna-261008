import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGuard } from '../src/fleetguard';
import { Policy, Target } from '../src/types';
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

const PROFILE_COUNT = 30;
const DEVICE_COUNT = 8;
const GROUP_COUNT = 4;
const SSID_UNIVERSE = ['corp', 'guest', 'lab', 'wifi-5g', 'cafe', 'home'];

function randomPolicy(rand: () => number): Policy {
  const policy: Policy = {};
  // 字段缺省：每个字段独立地以一定概率出现。
  if (rand() < 0.6) policy.minPinLength = 4 + Math.floor(rand() * 10);
  if (rand() < 0.6) policy.maxAutoLockSeconds = 15 + Math.floor(rand() * 300);
  if (rand() < 0.4) policy.allowCamera = rand() < 0.5;
  if (rand() < 0.4) policy.allowScreenshots = rand() < 0.5;
  const roll = rand();
  if (roll < 0.45) {
    // 随机子集，可能与其它白名单交集为空。
    const ssids = SSID_UNIVERSE.filter(() => rand() < 0.5);
    policy.allowedSsids = ssids;
  } else if (roll < 0.55) {
    // 空白名单：禁止所有 WiFi。
    policy.allowedSsids = [];
  }
  // 其余情况缺省白名单：不施加约束。
  return policy;
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function randomIds(rand: () => number, prefix: string, count: number, max: number): string[] {
  const ids = new Set<string>();
  const n = Math.floor(rand() * (max + 1));
  while (ids.size < n) ids.add(`${prefix}${Math.floor(rand() * count)}`);
  return [...ids];
}

for (const seed of [1, 7, 42, 2024]) {
  test(`random cross-check against reference (seed=${seed})`, () => {
    const rand = mulberry32(seed);
    const actual = new FleetGuard();
    const expected = new ReferenceFleetGuard();
    const devices = Array.from({ length: DEVICE_COUNT }, (_, i) => `dev${i}`);

    const checkAll = (op: string): void => {
      for (const deviceId of devices) {
        assert.deepEqual(actual.resolve(deviceId), expected.resolve(deviceId), `${op} @ ${deviceId}`);
      }
    };

    for (let step = 0; step < 800; step += 1) {
      const kind = rand();
      if (kind < 0.3) {
        const id = `p${Math.floor(rand() * PROFILE_COUNT)}`;
        const policy = randomPolicy(rand);
        actual.putProfile(id, policy);
        expected.putProfile(id, policy);
        checkAll(`putProfile(${id})`);
      } else if (kind < 0.65) {
        const target: Target =
          rand() < 0.5
            ? { kind: 'device', id: pick(rand, devices) }
            : { kind: 'group', id: `g${Math.floor(rand() * GROUP_COUNT)}` };
        const add = randomIds(rand, 'p', PROFILE_COUNT, 3);
        const remove = randomIds(rand, 'p', PROFILE_COUNT, 3);
        actual.bindProfiles(target, add, remove);
        expected.bindProfiles(target, add, remove);
        checkAll(`bindProfiles(${target.kind}:${target.id})`);
      } else {
        const deviceId = pick(rand, devices);
        const add = randomIds(rand, 'g', GROUP_COUNT, 2);
        const remove = randomIds(rand, 'g', GROUP_COUNT, 2);
        actual.joinGroups(deviceId, add, remove);
        expected.joinGroups(deviceId, add, remove);
        checkAll(`joinGroups(${deviceId})`);
      }
    }
  });
}

test('deterministic edge cases: defaults, empty whitelist, empty intersection', () => {
  const actual = new FleetGuard();
  const expected = new ReferenceFleetGuard();
  const check = (): void => {
    assert.deepEqual(actual.resolve('d'), expected.resolve('d'));
  };

  // 全缺省配置：不施加任何约束。
  actual.putProfile('empty', {});
  expected.putProfile('empty', {});
  actual.bindProfiles({ kind: 'device', id: 'd' }, ['empty'], []);
  expected.bindProfiles({ kind: 'device', id: 'd' }, ['empty'], []);
  check();
  assert.equal(actual.resolve('d').allowedSsids, null);

  // 空白名单：禁止所有 WiFi。
  actual.putProfile('nowifi', { allowedSsids: [] });
  expected.putProfile('nowifi', { allowedSsids: [] });
  actual.bindProfiles({ kind: 'device', id: 'd' }, ['nowifi'], []);
  expected.bindProfiles({ kind: 'device', id: 'd' }, ['nowifi'], []);
  check();
  assert.deepEqual(actual.resolve('d').allowedSsids, []);

  // 两个白名单交集为空。
  actual.putProfile('a', { allowedSsids: ['x', 'y'] });
  actual.putProfile('b', { allowedSsids: ['z'] });
  expected.putProfile('a', { allowedSsids: ['x', 'y'] });
  expected.putProfile('b', { allowedSsids: ['z'] });
  actual.bindProfiles({ kind: 'device', id: 'd' }, ['a', 'b'], ['nowifi']);
  expected.bindProfiles({ kind: 'device', id: 'd' }, ['a', 'b'], ['nowifi']);
  check();
  assert.deepEqual(actual.resolve('d').allowedSsids, []);

  // 撤销 b 后交集恢复为 a 的白名单。
  actual.bindProfiles({ kind: 'device', id: 'd' }, [], ['b']);
  expected.bindProfiles({ kind: 'device', id: 'd' }, [], ['b']);
  check();
  assert.deepEqual(actual.resolve('d').allowedSsids, ['x', 'y']);

  // 整体替换为缺省配置后，旧字段不保留。
  actual.putProfile('a', {});
  expected.putProfile('a', {});
  check();
  assert.equal(actual.resolve('d').allowedSsids, null);
});
