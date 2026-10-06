import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHarness } from './util.js';

test('有空位时申请直接获席，保留 60 秒', async () => {
  const { service, clock } = makeHarness({ capacity: 2, start: 1_000_000 });
  const result = await service.apply('ch', 'alice', 'req-1');
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'reserved');
  assert.equal(result.expiresAt, 1_000_000 + 60_000);
  const state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.equal(state.seats[0]?.status, 'reserved');
  assert.equal(clock.current(), 1_000_000);
  service.close();
});

test('重复提交同一申请：不新增占位、不改候补、不延长期限', async () => {
  const { service, clock } = makeHarness({ capacity: 1 });
  const first = await service.apply('ch', 'alice', 'req-1');
  clock.tick(30_000);
  const second = await service.apply('ch', 'alice', 'req-1');
  assert.equal(second.accepted, true);
  assert.equal(second.status, 'reserved');
  assert.equal(second.expiresAt, first.expiresAt);
  const state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  service.close();
});

test('同一用户已有未结束申请时，新申请被拒绝且不影响原申请', async () => {
  const { service } = makeHarness({ capacity: 2 });
  await service.apply('ch', 'alice', 'req-1');
  const rejected = await service.apply('ch', 'alice', 'req-2');
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.status, null);
  assert.equal(rejected.conflictRequestId, 'req-1');
  const state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.equal(state.seats[0]?.requestId, 'req-1');
  service.close();
});

test('满员后申请进入候补，按入队先后排序', async () => {
  const { service } = makeHarness({ capacity: 1 });
  await service.apply('ch', 'alice', 'req-a');
  const queued1 = await service.apply('ch', 'bob', 'req-b');
  const queued2 = await service.apply('ch', 'carol', 'req-c');
  assert.equal(queued1.status, 'queued');
  assert.equal(queued1.expiresAt, null);
  assert.equal(queued2.status, 'queued');
  const state = await service.getChannelState('ch');
  assert.deepEqual(
    state.queue.map((q) => [q.requestId, q.position]),
    [
      ['req-b', 1],
      ['req-c', 2],
    ],
  );
  service.close();
});

test('确认后进入观看，续期与确认都按当前时刻加 60 秒', async () => {
  const { service, clock } = makeHarness({ capacity: 1, start: 5_000_000 });
  await service.apply('ch', 'alice', 'req-1');
  clock.tick(10_000);
  const confirmed = await service.confirm('ch', 'alice', 'req-1');
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.expiresAt, 5_010_000 + 60_000);
  let state = await service.getChannelState('ch');
  assert.equal(state.seats[0]?.status, 'watching');
  clock.tick(50_000);
  const renewed = await service.confirm('ch', 'alice', 'req-1');
  assert.equal(renewed.ok, true);
  assert.equal(renewed.expiresAt, 5_060_000 + 60_000);
  state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  service.close();
});

test('确认/续期/退出只作用于指定申请：不存在、他人申请、候补中', async () => {
  const { service } = makeHarness({ capacity: 1 });
  await service.apply('ch', 'alice', 'req-a');
  await service.apply('ch', 'bob', 'req-b');
  assert.deepEqual(await service.confirm('ch', 'alice', 'req-x'), {
    ok: false,
    expiresAt: null,
    reason: 'not-found',
  });
  // 用户标识不匹配，视同不存在。
  assert.equal((await service.confirm('ch', 'mallory', 'req-a')).reason, 'not-found');
  // 候补中的申请不能确认。
  assert.equal((await service.confirm('ch', 'bob', 'req-b')).reason, 'not-active');
  // 退出他人申请无效。
  assert.deepEqual(await service.leave('ch', 'mallory', 'req-a'), { ended: false });
  const state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.equal(state.queue.length, 1);
  service.close();
});

test('退出释放席位，候补按顺序补位并收到通知', async () => {
  const { service, events, clock } = makeHarness({ capacity: 1, start: 2_000_000 });
  await service.apply('ch', 'alice', 'req-a');
  await service.apply('ch', 'bob', 'req-b');
  clock.tick(20_000);
  const left = await service.leave('ch', 'alice', 'req-a');
  assert.equal(left.ended, true);
  assert.deepEqual(await service.leave('ch', 'alice', 'req-a'), { ended: false });
  const state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.equal(state.seats[0]?.requestId, 'req-b');
  assert.equal(state.seats[0]?.expiresAt, 2_020_000 + 60_000);
  assert.equal(state.queue.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.requestId, 'req-b');
  assert.equal(events[0]?.userId, 'bob');
  assert.equal(events[0]?.expiresAt, 2_020_000 + 60_000);
  service.close();
});

test('候补退出后不再参与补位', async () => {
  const { service, events } = makeHarness({ capacity: 1 });
  await service.apply('ch', 'alice', 'req-a');
  await service.apply('ch', 'bob', 'req-b');
  await service.apply('ch', 'carol', 'req-c');
  assert.equal((await service.leave('ch', 'bob', 'req-b')).ended, true);
  await service.leave('ch', 'alice', 'req-a');
  const state = await service.getChannelState('ch');
  assert.equal(state.seats[0]?.requestId, 'req-c');
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['req-c'],
  );
  service.close();
});

test('通知接收方抛错不撤销占位', async () => {
  const { service } = makeHarness({
    capacity: 1,
    notify: async () => {
      throw new Error('receiver down');
    },
  });
  await service.apply('ch', 'alice', 'req-a');
  await service.apply('ch', 'bob', 'req-b');
  await service.leave('ch', 'alice', 'req-a');
  const state = await service.getChannelState('ch');
  assert.equal(state.occupied, 1);
  assert.equal(state.seats[0]?.requestId, 'req-b');
  service.close();
});

test('状态持久化在 SQLite，重开后仍在', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'admission-'));
  try {
    const dbPath = join(dir, 'state.db');
    const first = makeHarness({ capacity: 1, dbPath });
    await first.service.apply('ch', 'alice', 'req-a');
    await first.service.apply('ch', 'bob', 'req-b');
    first.service.close();
    const second = makeHarness({ capacity: 1, dbPath });
    const state = await second.service.getChannelState('ch');
    assert.equal(state.occupied, 1);
    assert.equal(state.seats[0]?.requestId, 'req-a');
    assert.equal(state.queue[0]?.requestId, 'req-b');
    second.service.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
