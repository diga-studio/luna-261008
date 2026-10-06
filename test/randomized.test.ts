import { test } from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { FleetGuard, type Policy, type Target } from '../src/index.js';
import { ReferenceModel, makeRng, pick } from './reference-model.js';

const PROFILE_COUNT = 40;
const DEVICE_COUNT = 30;
const GROUP_COUNT = 12;
const SSID_POOL = Array.from({ length: 30 }, (_, i) => `ssid-${i}`);
const OP_COUNT = 3000;

function randomPolicy(rng: () => number): Policy {
  const policy: Policy = {};
  if (rng() < 0.6) policy.minPinLength = 4 + Math.floor(rng() * 12);
  if (rng() < 0.6) policy.maxAutoLockSeconds = 15 + Math.floor(rng() * 300);
  if (rng() < 0.5) policy.allowCamera = rng() < 0.5;
  if (rng() < 0.5) policy.allowScreenshots = rng() < 0.5;
  const roll = rng();
  if (roll < 0.15) {
    policy.allowedSsids = []; // 空白名单：禁止所有 WiFi
  } else if (roll < 0.55) {
    const size = 1 + Math.floor(rng() * 8);
    const ssids = new Set<string>();
    while (ssids.size < size) ssids.add(pick(rng, SSID_POOL));
    policy.allowedSsids = [...ssids];
  }
  return policy;
}

function randomIds(rng: () => number, count: number, prefix: string): string[] {
  const ids = new Set<string>();
  const size = 1 + Math.floor(rng() * 3);
  while (ids.size < size) ids.add(`${prefix}${Math.floor(rng() * count)}`);
  return [...ids];
}

test('随机操作序列与逐份合并参考模型一致', () => {
  const rng = makeRng(20261006);
  const fg = new FleetGuard();
  const ref = new ReferenceModel();

  // 初始：全部配置先建立（部分后续会被整体替换）。
  for (let i = 0; i < PROFILE_COUNT; i++) {
    const policy = randomPolicy(rng);
    fg.putProfile(`p${i}`, policy);
    ref.putProfile(`p${i}`, policy);
  }

  for (let op = 0; op < OP_COUNT; op++) {
    const kind = rng();
    if (kind < 0.3) {
      // 整体替换一份配置（缺省字段不保留旧值）。
      const id = `p${Math.floor(rng() * PROFILE_COUNT)}`;
      const policy = randomPolicy(rng);
      fg.putProfile(id, policy);
      ref.putProfile(id, policy);
    } else if (kind < 0.7) {
      const target: Target =
        rng() < 0.5
          ? { kind: 'device', id: `d${Math.floor(rng() * DEVICE_COUNT)}` }
          : { kind: 'group', id: `g${Math.floor(rng() * GROUP_COUNT)}` };
      const add = randomIds(rng, PROFILE_COUNT, 'p');
      const remove = randomIds(rng, PROFILE_COUNT, 'p');
      fg.bindProfiles(target, add, remove);
      ref.bindProfiles(target, add, remove);
    } else {
      const deviceId = `d${Math.floor(rng() * DEVICE_COUNT)}`;
      const add = randomIds(rng, GROUP_COUNT, 'g');
      const remove = randomIds(rng, GROUP_COUNT, 'g');
      fg.joinGroups(deviceId, add, remove);
      ref.joinGroups(deviceId, add, remove);
    }

    // 每 50 步全量核对所有设备，其余步骤抽查 3 台。
    if (op % 50 === 0) {
      for (let d = 0; d < DEVICE_COUNT; d++) {
        deepEqual(fg.resolve(`d${d}`), ref.resolve(`d${d}`), `op=${op} device=d${d}`);
      }
    } else {
      for (let k = 0; k < 3; k++) {
        const d = Math.floor(rng() * DEVICE_COUNT);
        deepEqual(fg.resolve(`d${d}`), ref.resolve(`d${d}`), `op=${op} device=d${d}`);
      }
    }
  }
});

test('字段缺省、空白名单、交集为空的基础行为', () => {
  const fg = new FleetGuard();
  fg.putProfile('empty', {});
  fg.putProfile('blank-wifi', { allowedSsids: [] });
  fg.putProfile('wifi-a', { allowedSsids: ['a', 'b'] });
  fg.putProfile('wifi-b', { allowedSsids: ['c', 'd'] });
  const dev = { kind: 'device' as const, id: 'd0' };

  fg.bindProfiles(dev, ['empty'], []);
  deepEqual(fg.resolve('d0'), {
    minPinLength: 6,
    maxAutoLockSeconds: 120,
    allowCamera: true,
    allowScreenshots: true,
    allowedSsids: null,
  });

  fg.bindProfiles(dev, ['blank-wifi'], []);
  deepEqual(fg.resolve('d0').allowedSsids, [], '空白名单禁止所有 WiFi');

  fg.bindProfiles(dev, [], ['blank-wifi']);
  fg.bindProfiles(dev, ['wifi-a', 'wifi-b'], []);
  deepEqual(fg.resolve('d0').allowedSsids, [], '两个不相交白名单交集为空');

  fg.bindProfiles(dev, [], ['wifi-b']);
  deepEqual(fg.resolve('d0').allowedSsids, ['a', 'b']);

  fg.bindProfiles(dev, [], ['wifi-a']);
  deepEqual(fg.resolve('d0').allowedSsids, null, '无白名单声明时返回 null');
});
