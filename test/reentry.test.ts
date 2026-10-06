import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHarness } from './util.js';

// 场景：同一用户的旧申请结束后重新入场，再收到旧通知及旧申请的重复操作；
// 新席位和候补顺序均不受影响。
test('旧申请结束后重新入场，旧通知与重复操作不影响新席位与候补顺序', async () => {
  const t0 = 30_000_000;
  const { service, events, clock } = makeHarness({ capacity: 1, start: t0 });

  // X 占席；U 的旧申请 req-old 候补；Y 随后候补。
  await service.apply('ch', 'xena', 'req-x');
  await service.apply('ch', 'user', 'req-old');
  await service.apply('ch', 'yann', 'req-y');

  // X 退出，req-old 补位并收到通知（旧通知）。
  clock.tick(10_000); // now = t0 + 10s
  await service.leave('ch', 'xena', 'req-x');
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['req-old'],
  );
  assert.equal(events[0]?.expiresAt, t0 + 10_000 + 60_000);

  // req-old 未确认，到期结束；Y 补位。
  clock.tick(60_000); // now = t0 + 70s，恰为 req-old 到期时刻
  let state = await service.getChannelState('ch');
  assert.deepEqual(
    state.seats.map((s) => s.requestId),
    ['req-y'],
  );
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['req-old', 'req-y'],
  );

  // 同一用户用新标识重新入场：满员，进入候补。
  const reentry = await service.apply('ch', 'user', 'req-new');
  assert.equal(reentry.accepted, true);
  assert.equal(reentry.status, 'queued');
  // Z 也来候补，排在 req-new 之后。
  await service.apply('ch', 'zoe', 'req-z');

  // Y 退出，req-new 补位获得新席位。
  clock.tick(5_000); // now = t0 + 75s
  await service.leave('ch', 'yann', 'req-y');
  state = await service.getChannelState('ch');
  assert.deepEqual(
    state.seats.map((s) => s.requestId),
    ['req-new'],
  );
  const newSeatExpiry = t0 + 75_000 + 60_000;
  assert.equal(state.seats[0]?.expiresAt, newSeatExpiry);
  assert.deepEqual(
    state.queue.map((q) => q.requestId),
    ['req-z'],
  );

  // 上层收到迟到的旧通知（req-old），据此发起迟到确认：不得影响新席位。
  const staleConfirm = await service.confirm('ch', 'user', 'req-old');
  assert.equal(staleConfirm.ok, false);
  assert.equal(staleConfirm.reason, 'ended');
  // 旧申请的迟到退出：不得释放新席位。
  assert.deepEqual(await service.leave('ch', 'user', 'req-old'), { ended: false });
  // 旧申请的重复提交：不得复活、不得新增占位、不得改变候补顺序。
  const replay = await service.apply('ch', 'user', 'req-old');
  assert.equal(replay.accepted, false);
  assert.equal(replay.status, 'ended');
  // 旧申请的迟到续期：不得延长期限（req-old 已结束，无法续期）。
  assert.equal((await service.confirm('ch', 'user', 'req-old')).ok, false);

  state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.deepEqual(
    state.seats.map((s) => [s.requestId, s.expiresAt]),
    [['req-new', newSeatExpiry]],
  );
  assert.deepEqual(
    state.queue.map((q) => q.requestId),
    ['req-z'],
  );
  // 没有产生新的补位通知。
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['req-old', 'req-y', 'req-new'],
  );

  // 新申请的重复提交：幂等，不延长期限、不影响候补。
  clock.tick(30_000);
  const dupNew = await service.apply('ch', 'user', 'req-new');
  assert.equal(dupNew.accepted, true);
  assert.equal(dupNew.status, 'reserved');
  assert.equal(dupNew.expiresAt, newSeatExpiry);
  state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.deepEqual(
    state.queue.map((q) => q.requestId),
    ['req-z'],
  );
  service.close();
});
