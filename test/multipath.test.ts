import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGuard } from '../src/fleetguard';
import { EffectivePolicy } from '../src/types';
import { ReferenceFleetGuard } from './reference';

/**
 * 同一配置经直接绑定及两个组同时命中；
 * 逐条撤销路径时约束不丢失，最后一个来源消失时限制正确放宽。
 */
test('multi-path hit: unbinding one path keeps constraints from others', () => {
  const actual = new FleetGuard();
  const expected = new ReferenceFleetGuard();
  const check = (step: string): void => {
    assert.deepEqual(actual.resolve('dev'), expected.resolve('dev'), step);
  };

  actual.putProfile('strict', {
    minPinLength: 12,
    maxAutoLockSeconds: 30,
    allowCamera: false,
    allowScreenshots: false,
    allowedSsids: ['corp'],
  });
  expected.putProfile('strict', {
    minPinLength: 12,
    maxAutoLockSeconds: 30,
    allowCamera: false,
    allowScreenshots: false,
    allowedSsids: ['corp'],
  });

  // 三条路径同时命中同一配置：直接绑定 + 组 g1 + 组 g2。
  actual.bindProfiles({ kind: 'device', id: 'dev' }, ['strict'], []);
  actual.bindProfiles({ kind: 'group', id: 'g1' }, ['strict'], []);
  actual.bindProfiles({ kind: 'group', id: 'g2' }, ['strict'], []);
  actual.joinGroups('dev', ['g1', 'g2'], []);
  expected.bindProfiles({ kind: 'device', id: 'dev' }, ['strict'], []);
  expected.bindProfiles({ kind: 'group', id: 'g1' }, ['strict'], []);
  expected.bindProfiles({ kind: 'group', id: 'g2' }, ['strict'], []);
  expected.joinGroups('dev', ['g1', 'g2'], []);

  const strictPolicy: EffectivePolicy = {
    minPinLength: 12,
    maxAutoLockSeconds: 30,
    allowCamera: false,
    allowScreenshots: false,
    allowedSsids: ['corp'],
  };
  assert.deepEqual(actual.resolve('dev'), strictPolicy);
  check('all three paths');

  // 撤销直接绑定：组路径仍在，约束不变。
  actual.bindProfiles({ kind: 'device', id: 'dev' }, [], ['strict']);
  expected.bindProfiles({ kind: 'device', id: 'dev' }, [], ['strict']);
  assert.deepEqual(actual.resolve('dev'), strictPolicy);
  check('direct binding removed');

  // 退出 g1：g2 路径仍在，约束不变。
  actual.joinGroups('dev', [], ['g1']);
  expected.joinGroups('dev', [], ['g1']);
  assert.deepEqual(actual.resolve('dev'), strictPolicy);
  check('left g1');

  // 解除 g2 上的绑定：最后一条路径消失，全部限制放宽到基础值。
  actual.bindProfiles({ kind: 'group', id: 'g2' }, [], ['strict']);
  expected.bindProfiles({ kind: 'group', id: 'g2' }, [], ['strict']);
  assert.deepEqual(actual.resolve('dev'), {
    minPinLength: 6,
    maxAutoLockSeconds: 120,
    allowCamera: true,
    allowScreenshots: true,
    allowedSsids: null,
  });
  check('last path removed');
});

/**
 * 撤销最严格来源后恢复到剩余来源共同要求的值；
 * WiFi 从禁止全部 → 有限集合 → 无限制。
 */
test('strictest source removal relaxes to remaining sources', () => {
  const actual = new FleetGuard();
  const expected = new ReferenceFleetGuard();
  const check = (step: string): void => {
    assert.deepEqual(actual.resolve('dev'), expected.resolve('dev'), step);
  };

  // 最严格来源：禁止所有 WiFi（空白名单）。
  actual.putProfile('strictest', {
    minPinLength: 16,
    maxAutoLockSeconds: 10,
    allowCamera: false,
    allowScreenshots: false,
    allowedSsids: [],
  });
  // 中等来源：有限白名单。
  actual.putProfile('mid', {
    minPinLength: 10,
    maxAutoLockSeconds: 60,
    allowCamera: false,
    allowedSsids: ['corp', 'lab'],
  });
  // 宽松来源：另一有限白名单。
  actual.putProfile('loose', {
    minPinLength: 8,
    allowedSsids: ['corp', 'guest'],
  });
  expected.putProfile('strictest', {
    minPinLength: 16,
    maxAutoLockSeconds: 10,
    allowCamera: false,
    allowScreenshots: false,
    allowedSsids: [],
  });
  expected.putProfile('mid', {
    minPinLength: 10,
    maxAutoLockSeconds: 60,
    allowCamera: false,
    allowedSsids: ['corp', 'lab'],
  });
  expected.putProfile('loose', {
    minPinLength: 8,
    allowedSsids: ['corp', 'guest'],
  });

  actual.bindProfiles({ kind: 'group', id: 'g' }, ['strictest', 'mid'], []);
  actual.bindProfiles({ kind: 'device', id: 'dev' }, ['loose'], []);
  actual.joinGroups('dev', ['g'], []);
  expected.bindProfiles({ kind: 'group', id: 'g' }, ['strictest', 'mid'], []);
  expected.bindProfiles({ kind: 'device', id: 'dev' }, ['loose'], []);
  expected.joinGroups('dev', ['g'], []);

  // 空白名单主导：禁止所有 WiFi。
  assert.deepEqual(actual.resolve('dev'), {
    minPinLength: 16,
    maxAutoLockSeconds: 10,
    allowCamera: false,
    allowScreenshots: false,
    allowedSsids: [],
  });
  check('strictest present');

  // 撤销最严格来源：WiFi 从禁止全部恢复为两个有限白名单的交集。
  actual.bindProfiles({ kind: 'group', id: 'g' }, [], ['strictest']);
  expected.bindProfiles({ kind: 'group', id: 'g' }, [], ['strictest']);
  assert.deepEqual(actual.resolve('dev'), {
    minPinLength: 10,
    maxAutoLockSeconds: 60,
    allowCamera: false,
    allowScreenshots: true,
    allowedSsids: ['corp'],
  });
  check('strictest removed');

  // 改写 mid 为不含白名单的配置：交集只剩 loose 的白名单。
  actual.putProfile('mid', { minPinLength: 10, maxAutoLockSeconds: 60, allowCamera: false });
  expected.putProfile('mid', { minPinLength: 10, maxAutoLockSeconds: 60, allowCamera: false });
  assert.deepEqual(actual.resolve('dev').allowedSsids, ['corp', 'guest']);
  check('mid rewritten without whitelist');

  // 最后一个白名单来源也消失：恢复为无限制（null，而非空数组）。
  actual.bindProfiles({ kind: 'device', id: 'dev' }, [], ['loose']);
  expected.bindProfiles({ kind: 'device', id: 'dev' }, [], ['loose']);
  assert.deepEqual(actual.resolve('dev'), {
    minPinLength: 10,
    maxAutoLockSeconds: 60,
    allowCamera: false,
    allowScreenshots: true,
    allowedSsids: null,
  });
  check('last whitelist source removed');
});
