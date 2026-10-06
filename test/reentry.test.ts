import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_TTL_MS } from '../src/index.js';
import { makeHarness } from './helpers.js';

/**
 * 场景：同一用户的旧申请结束后重新入场，再收到旧通知及旧申请的重复操作；
 * 新席位和候补顺序均不受影响。
 */
test('旧申请结束后重新入场，旧通知与旧申请的重复操作不影响新席位', async () => {
  const { admission, clock, events } = makeHarness(1);
  const t0 = clock.now();

  // 旧申请获席并确认，随后到期结束
  await admission.apply('ch', 'alice', 'old-req');
  await admission.confirm('ch', 'alice', 'old-req');
  clock.set(t0 + SESSION_TTL_MS);

  // 重新入场须使用新标识；旧标识重试不得复活
  const retryOld = await admission.apply('ch', 'alice', 'old-req');
  assert.equal(retryOld.kind, 'ended');
  const reentry = await admission.apply('ch', 'alice', 'new-req');
  assert.equal(reentry.kind, 'reserved');
  assert.equal(reentry.kind === 'reserved' && reentry.record.expiresAt, t0 + 2 * SESSION_TTL_MS);

  // 旧申请的迟到确认 / 续期 / 退出：全部无效
  assert.equal((await admission.confirm('ch', 'alice', 'old-req')).kind, 'not-active');
  assert.equal((await admission.leave('ch', 'alice', 'old-req')).kind, 'not-active');
  // 旧申请的重复提交也不新增占位
  assert.equal((await admission.apply('ch', 'alice', 'old-req')).kind, 'ended');

  // 新席位不受影响：仍可确认进入观看，期限不变
  const confirmed = await admission.confirm('ch', 'alice', 'new-req');
  assert.equal(confirmed.kind, 'confirmed');
  assert.equal(
    confirmed.kind === 'confirmed' && confirmed.record.expiresAt,
    t0 + 2 * SESSION_TTL_MS,
  );
  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 1);
  assert.equal(status.watchingCount, 1);
  assert.equal(events.length, 0);
  admission.close();
});

test('旧候补通知迟到时，旧申请操作不影响他人已补位的席位与候补顺序', async () => {
  const { admission, clock, events } = makeHarness(1);

  // alice 占席，bob 候补；alice 到期后 bob 补位（通知可能迟到才送达上层）
  await admission.apply('ch', 'alice', 'a1');
  await admission.apply('ch', 'bob', 'b1');
  clock.advance(SESSION_TTL_MS);
  await admission.status('ch'); // 触发结算：bob 补位
  assert.deepEqual(events, [{ channelId: 'ch', requestId: 'b1', userId: 'bob' }]);

  // carol 随后排队
  await admission.apply('ch', 'carol', 'c1');

  // 上层收到迟到的旧通知/旧状态，对 alice 的旧申请做重复操作
  assert.equal((await admission.confirm('ch', 'alice', 'a1')).kind, 'not-active');
  assert.equal((await admission.leave('ch', 'alice', 'a1')).kind, 'not-active');
  assert.equal((await admission.apply('ch', 'alice', 'a1')).kind, 'ended');

  // bob 的补位席位与 carol 的候补位置都不受影响
  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 1);
  assert.deepEqual(
    status.queued.map((q) => q.requestId),
    ['c1'],
  );
  const bobConfirm = await admission.confirm('ch', 'bob', 'b1');
  assert.equal(bobConfirm.kind, 'confirmed');
  admission.close();
});

test('用户退出后重新入场获得新席位，旧申请的退出不影响新席位', async () => {
  const { admission, clock } = makeHarness(1);

  await admission.apply('ch', 'alice', 'req-1');
  await admission.leave('ch', 'alice', 'req-1');

  // 用新标识重新入场
  const reentry = await admission.apply('ch', 'alice', 'req-2');
  assert.equal(reentry.kind, 'reserved');

  // 迟到的旧申请退出 / 确认不得作用于新席位
  assert.equal((await admission.leave('ch', 'alice', 'req-1')).kind, 'not-active');
  assert.equal((await admission.confirm('ch', 'alice', 'req-1')).kind, 'not-active');

  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 1);

  // 新席位在 60 秒边界准时失效，说明期限未被旧操作改动
  clock.advance(SESSION_TTL_MS);
  assert.equal((await admission.confirm('ch', 'alice', 'req-2')).kind, 'not-active');
  admission.close();
});
