import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHarness } from './util.js';

// 场景：满员且有候补时，在到期边界进行续期、退出和新申请；
// 最终无超额占位，补位遵守候补顺序。
test('到期边界：续期、退出、新申请，补位遵守候补顺序且不超额', async () => {
  const t0 = 10_000_000;
  const { service, events, clock } = makeHarness({ capacity: 2, start: t0 });

  // 满员：A、B 获席；C、D 依次候补。
  await service.apply('ch', 'alice', 'req-a');
  await service.apply('ch', 'bob', 'req-b');
  await service.apply('ch', 'carol', 'req-c');
  await service.apply('ch', 'dave', 'req-d');
  let state = await service.getChannelState('ch');
  assert.equal(state.occupied, 2);
  assert.deepEqual(
    state.queue.map((q) => q.requestId),
    ['req-c', 'req-d'],
  );

  // B 在到期前 1 毫秒续期成功，期限更新为当前时刻 +60s。
  clock.tick(59_999); // now = t0 + 59_999
  const renewed = await service.confirm('ch', 'bob', 'req-b');
  assert.equal(renewed.ok, true);
  assert.equal(renewed.expiresAt, t0 + 59_999 + 60_000);

  // 推进到 A 的到期边界（now == expiresAt）：A 已失效，续期失败；
  // 同一时刻 C 补位，新 60 秒自实际分配时刻起算。
  clock.tick(1); // now = t0 + 60_000，恰为 A 的到期时刻
  const expiredConfirm = await service.confirm('ch', 'alice', 'req-a');
  assert.equal(expiredConfirm.ok, false);
  assert.equal(expiredConfirm.reason, 'ended');
  state = await service.getChannelState('ch');
  assert.equal(state.occupied, 2);
  assert.deepEqual(
    state.seats.map((s) => s.requestId).sort(),
    ['req-b', 'req-c'],
  );
  assert.equal(state.seats.find((s) => s.requestId === 'req-c')?.expiresAt, t0 + 60_000 + 60_000);
  assert.deepEqual(
    state.queue.map((q) => q.requestId),
    ['req-d'],
  );
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['req-c'],
  );
  assert.equal(events[0]?.expiresAt, t0 + 60_000 + 60_000);

  // 到期边界上的新申请：满员且有候补，进入候补队尾。
  const lateApply = await service.apply('ch', 'erin', 'req-e');
  assert.equal(lateApply.status, 'queued');
  state = await service.getChannelState('ch');
  assert.deepEqual(
    state.queue.map((q) => q.requestId),
    ['req-d', 'req-e'],
  );

  // 推进到 B 的到期边界（now == expiresAt）：B 已失效，退出返回 false；
  // D 按顺序补位，C 的席位不受影响。
  const bExpiry = t0 + 59_999 + 60_000;
  clock.tick(bExpiry - clock.current()); // now == B 的到期时刻
  const leaveResult = await service.leave('ch', 'bob', 'req-b');
  assert.equal(leaveResult.ended, false);
  state = await service.getChannelState('ch');
  assert.equal(state.occupied, 2);
  assert.deepEqual(
    state.seats.map((s) => s.requestId).sort(),
    ['req-c', 'req-d'],
  );
  assert.equal(state.seats.find((s) => s.requestId === 'req-d')?.expiresAt, bExpiry + 60_000);
  assert.deepEqual(
    state.queue.map((q) => q.requestId),
    ['req-e'],
  );
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['req-c', 'req-d'],
  );

  // C 主动退出（未到期），E 补位；全程占用不超过容量。
  await service.leave('ch', 'carol', 'req-c');
  state = await service.getChannelState('ch');
  assert.equal(state.occupied, 2);
  assert.deepEqual(
    state.seats.map((s) => s.requestId).sort(),
    ['req-d', 'req-e'],
  );
  assert.equal(state.queue.length, 0);
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['req-c', 'req-d', 'req-e'],
  );
  assert.ok(state.occupied <= state.capacity);
  service.close();
});

// 到期边界上查询必须反映已到期席位与相应补位。
test('查询反映当前时刻已到期席位及补位', async () => {
  const t0 = 20_000_000;
  const { service, clock } = makeHarness({ capacity: 1, start: t0 });
  await service.apply('ch', 'alice', 'req-a');
  await service.apply('ch', 'bob', 'req-b');
  clock.tick(60_000); // now == req-a 到期时刻
  const state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.equal(state.seats[0]?.requestId, 'req-b');
  assert.equal(state.seats[0]?.expiresAt, t0 + 60_000 + 60_000);
  assert.equal(state.queue.length, 0);
  service.close();
});
