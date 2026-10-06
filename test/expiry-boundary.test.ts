import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_TTL_MS } from '../src/index.js';
import { makeHarness } from './helpers.js';

/**
 * 场景：满员且有候补时，在到期边界进行续期、退出和新申请；
 * 最终无超额占位，补位遵守候补顺序。
 */
test('满员有候补时的到期边界：续期、退出、新申请', async () => {
  const { admission, clock, events } = makeHarness(2);
  const t0 = clock.now();

  // 占满 2 个席位：alice 观看中，bob 保留中
  await admission.apply('ch', 'alice', 'a1');
  await admission.apply('ch', 'bob', 'b1');
  await admission.confirm('ch', 'alice', 'a1'); // watching, 到期 = t0+60s
  // bob 在 30 秒时确认，到期 = t0+90s，与 alice 错开
  clock.set(t0 + 30_000);
  await admission.confirm('ch', 'bob', 'b1');
  // 候补：carol 先于 dave
  const c1 = await admission.apply('ch', 'carol', 'c1');
  const d1 = await admission.apply('ch', 'dave', 'd1');
  assert.equal(c1.kind, 'queued');
  assert.equal(d1.kind, 'queued');
  assert.equal(c1.kind === 'queued' && c1.position, 1);
  assert.equal(d1.kind === 'queued' && d1.position, 2);

  // 推进到 alice 的到期边界：当前时刻 == 到期时刻，已失效，不能续期
  clock.set(t0 + SESSION_TTL_MS);
  const renewLate = await admission.confirm('ch', 'alice', 'a1');
  assert.equal(renewLate.kind, 'not-active');

  // alice 的席位由最早候补 carol 补上，dave 仍排队；无超额占位
  let status = await admission.status('ch');
  assert.equal(status.occupiedCount, 2);
  assert.equal(status.reservedCount + status.watchingCount, 2);
  assert.deepEqual(
    status.queued.map((q) => q.requestId),
    ['d1'],
  );
  assert.deepEqual(events, [{ channelId: 'ch', requestId: 'c1', userId: 'carol' }]);

  // carol 的补位期限从实际分配时刻（t0+60s）起算
  const carolConfirm = await admission.confirm('ch', 'carol', 'c1');
  assert.equal(carolConfirm.kind, 'confirmed');
  assert.equal(
    carolConfirm.kind === 'confirmed' && carolConfirm.record.expiresAt,
    t0 + 2 * SESSION_TTL_MS,
  );

  // 边界上的新申请：没有空位，只能入队，且排在 dave 之后
  const e1 = await admission.apply('ch', 'erin', 'e1');
  assert.equal(e1.kind, 'queued');
  assert.equal(e1.kind === 'queued' && e1.position, 2);

  // bob 恰在自己的到期边界（t0+90s）退出：先结算到期，bob 的席位已失效，
  // dave 先补位；bob 的退出落在已结束申请上，幂等无效果
  clock.set(t0 + 30_000 + SESSION_TTL_MS);
  const bobLeave = await admission.leave('ch', 'bob', 'b1');
  assert.equal(bobLeave.kind, 'not-active');
  status = await admission.status('ch');
  assert.equal(status.occupiedCount, 2);
  assert.deepEqual(
    status.queued.map((q) => q.requestId),
    ['e1'],
  );

  // carol 在观看中退出，erin 补位；通知按序发出
  const carolLeave = await admission.leave('ch', 'carol', 'c1');
  assert.equal(carolLeave.kind, 'left');
  status = await admission.status('ch');
  assert.equal(status.occupiedCount, 2);
  assert.equal(status.queued.length, 0);
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['c1', 'd1', 'e1'],
  );

  // 全程无超额占位
  assert.ok(status.occupiedCount <= status.capacity);
  admission.close();
});

test('到期边界上多个席位同时失效时按候补顺序依次补位', async () => {
  const { admission, clock, events } = makeHarness(2);

  await admission.apply('ch', 'alice', 'a1');
  await admission.apply('ch', 'bob', 'b1');
  await admission.apply('ch', 'carol', 'c1');
  await admission.apply('ch', 'dave', 'd1');
  await admission.apply('ch', 'erin', 'e1');

  // 两个席位同时到期
  clock.advance(SESSION_TTL_MS);
  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 2);
  assert.deepEqual(
    status.queued.map((q) => q.requestId),
    ['e1'],
  );
  assert.deepEqual(
    events.map((e) => e.requestId),
    ['c1', 'd1'],
  );
  admission.close();
});
