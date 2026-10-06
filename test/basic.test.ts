import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelAdmission } from '../src/index.js';
import { SESSION_TTL_MS } from '../src/index.js';
import { makeClock, makeHarness } from './helpers.js';

test('有空位时申请直接获席，确认后进入观看', async () => {
  const { admission, clock } = makeHarness(2);
  const t0 = clock.now();

  const applied = await admission.apply('ch', 'alice', 'req-1');
  assert.equal(applied.kind, 'reserved');
  assert.equal(applied.kind === 'reserved' && applied.record.expiresAt, t0 + SESSION_TTL_MS);

  const confirmed = await admission.confirm('ch', 'alice', 'req-1');
  assert.equal(confirmed.kind, 'confirmed');

  const status = await admission.status('ch');
  assert.equal(status.watchingCount, 1);
  assert.equal(status.occupiedCount, 1);
  admission.close();
});

test('重复提交同一申请：不新增占位、不改变候补顺序、不延长期限', async () => {
  const { admission, clock } = makeHarness(1);
  const first = await admission.apply('ch', 'alice', 'req-1');
  assert.equal(first.kind, 'reserved');
  const expiry = first.kind === 'reserved' ? first.record.expiresAt : null;

  clock.advance(10_000);
  const dup = await admission.apply('ch', 'alice', 'req-1');
  assert.equal(dup.kind, 'duplicate');
  assert.equal(dup.kind === 'duplicate' && dup.record.expiresAt, expiry);

  // 占满后候补的重复提交也不改变顺序
  await admission.apply('ch', 'bob', 'req-2');
  const queuedDup = await admission.apply('ch', 'carol', 'req-3');
  assert.equal(queuedDup.kind, 'queued');
  const again = await admission.apply('ch', 'carol', 'req-3');
  assert.equal(again.kind, 'duplicate');
  const status = await admission.status('ch');
  assert.deepEqual(
    status.queued.map((q) => q.requestId),
    ['req-2', 'req-3'],
  );
  admission.close();
});

test('同一用户已有未结束申请时，新申请被拒绝且不影响原申请', async () => {
  const { admission } = makeHarness(2);
  await admission.apply('ch', 'alice', 'req-1');
  const conflict = await admission.apply('ch', 'alice', 'req-2');
  assert.equal(conflict.kind, 'conflict');
  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 1);
  admission.close();
});

test('到期时刻等于当前时刻即失效，不能再续期', async () => {
  const { admission, clock } = makeHarness(1);
  const applied = await admission.apply('ch', 'alice', 'req-1');
  const expiry = applied.kind === 'reserved' ? applied.record.expiresAt! : 0;

  clock.set(expiry - 1);
  const stillValid = await admission.confirm('ch', 'alice', 'req-1');
  assert.equal(stillValid.kind, 'confirmed');

  const newExpiry = stillValid.kind === 'confirmed' ? stillValid.record.expiresAt! : 0;
  clock.set(newExpiry);
  const late = await admission.confirm('ch', 'alice', 'req-1');
  assert.equal(late.kind, 'not-active');

  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 0);
  admission.close();
});

test('退出释放席位并按入队顺序补位，通知携带申请标识', async () => {
  const { admission, events } = makeHarness(1);
  await admission.apply('ch', 'alice', 'req-1');
  await admission.apply('ch', 'bob', 'req-2');
  await admission.apply('ch', 'carol', 'req-3');

  const left = await admission.leave('ch', 'alice', 'req-1');
  assert.equal(left.kind, 'left');

  assert.deepEqual(events, [{ channelId: 'ch', requestId: 'req-2', userId: 'bob' }]);
  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 1);
  assert.deepEqual(
    status.queued.map((q) => q.requestId),
    ['req-3'],
  );
  admission.close();
});

test('退出候补后不再参与补位', async () => {
  const { admission, events } = makeHarness(1);
  await admission.apply('ch', 'alice', 'req-1');
  await admission.apply('ch', 'bob', 'req-2');
  await admission.apply('ch', 'carol', 'req-3');

  await admission.leave('ch', 'bob', 'req-2');
  await admission.leave('ch', 'alice', 'req-1');

  assert.deepEqual(events, [{ channelId: 'ch', requestId: 'req-3', userId: 'carol' }]);
  admission.close();
});

test('通知接收方抛错不撤销占位', async () => {
  const { admission } = makeHarness(1, {
    notifier: async () => {
      throw new Error('receiver down');
    },
  });
  await admission.apply('ch', 'alice', 'req-1');
  await admission.apply('ch', 'bob', 'req-2');
  await admission.leave('ch', 'alice', 'req-1');

  const status = await admission.status('ch');
  assert.equal(status.occupiedCount, 1);
  assert.equal(status.reservedCount, 1);
  admission.close();
});

test('补位的 60 秒从实际分配时起算，迟到通知不延长期限', async () => {
  const { admission, clock } = makeHarness(1, {
    notifier: async () => {
      clock.advance(30_000); // 模拟通知通道很慢
    },
  });
  await admission.apply('ch', 'alice', 'req-1');
  await admission.apply('ch', 'bob', 'req-2');

  const allocTime = clock.now();
  await admission.leave('ch', 'alice', 'req-1');
  // 通知期间时钟走了 30s，但期限从分配时刻起算
  clock.set(allocTime + SESSION_TTL_MS);
  const lateConfirm = await admission.confirm('ch', 'bob', 'req-2');
  assert.equal(lateConfirm.kind, 'not-active');
  admission.close();
});

test('状态持久化到 SQLite 文件，重开后仍在', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'admission-')), 'state.db');
  const clock = makeClock();

  const a1 = new ChannelAdmission({ dbPath, capacity: 1, now: clock.now });
  await a1.apply('ch', 'alice', 'req-1');
  await a1.apply('ch', 'bob', 'req-2');
  a1.close();

  const a2 = new ChannelAdmission({ dbPath, capacity: 1, now: clock.now });
  const status = await a2.status('ch');
  assert.equal(status.occupiedCount, 1);
  assert.deepEqual(
    status.queued.map((q) => q.requestId),
    ['req-2'],
  );
  a2.close();
});
