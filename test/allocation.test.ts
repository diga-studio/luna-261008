import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/shelfsync.js';

test('较早的跨馆预约优先于较晚的本馆预约', async () => {
  const lib = new ShelfSync(':memory:');
  await lib.registerCopy('题名A', 'BC-001', 'branch-1');

  // 先到的预约：领取分馆是 branch-2（跨馆）
  const h1 = await lib.placeHold('题名A', 'reader-1', 'branch-2');
  // 后到的预约：领取分馆是 branch-1（本馆，册就在架上）
  const h2 = await lib.placeHold('题名A', 'reader-2', 'branch-1');

  const hold1 = await lib.getHold(h1.holdId);
  const hold2 = await lib.getHold(h2.holdId);
  const copy = await lib.getCopy('BC-001');

  // 较早预约抢到唯一的册：产生调拨，目的分馆固定为 branch-2
  assert.equal(hold1?.status, 'bound');
  assert.equal(hold1?.barcode, 'BC-001');
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-2');
  assert.equal(copy?.holdId, h1.holdId);
  assert.ok(copy?.transferCredential);
  // 较晚的本馆预约不能抢走，继续排队
  assert.equal(hold2?.status, 'pending');
  assert.equal(hold2?.barcode, null);
  lib.close();
});

test('只有空闲在途册时，不兼容的队首可被跳过', async () => {
  const lib = new ShelfSync(':memory:');
  await lib.registerCopy('题名B', 'BC-101', 'branch-1');

  // 制造一册运往 branch-2 的空闲在途册：先预约产生调拨，再撤销解除绑定
  const h0 = await lib.placeHold('题名B', 'reader-0', 'branch-2');
  const copy0 = await lib.getCopy('BC-101');
  assert.equal(copy0?.status, 'in_transit');
  assert.equal(copy0?.branch, 'branch-2');
  await lib.cancelHold(h0.holdId);
  const copyFree = await lib.getCopy('BC-101');
  assert.equal(copyFree?.status, 'in_transit');
  assert.equal(copyFree?.branch, 'branch-2');
  assert.equal(copyFree?.holdId, null);

  // 队首：领取分馆 branch-1，与在途册目的分馆不兼容
  const h1 = await lib.placeHold('题名B', 'reader-1', 'branch-1');
  // 队尾：领取分馆 branch-2，恰好在途册运往该馆
  const h2 = await lib.placeHold('题名B', 'reader-2', 'branch-2');

  const hold1 = await lib.getHold(h1.holdId);
  const hold2 = await lib.getHold(h2.holdId);
  const copy = await lib.getCopy('BC-101');

  // 队首无法使用该册，保持排队；队尾兼容预约获得该册
  assert.equal(hold1?.status, 'pending');
  assert.equal(hold1?.barcode, null);
  assert.equal(hold2?.status, 'bound');
  assert.equal(hold2?.barcode, 'BC-101');
  // 在途册不因此改道
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-2');
  assert.equal(copy?.holdId, h2.holdId);
  lib.close();
});

test('取消后重新预约排到队尾；已绑定的预约不被抢走', async () => {
  const lib = new ShelfSync(':memory:');
  await lib.registerCopy('题名H', 'BC-901', 'branch-1');

  // H1 先预约并绑定唯一的册（本馆在架，直接可领取）
  const h1 = await lib.placeHold('题名H', 'reader-1', 'branch-1');
  assert.equal((await lib.getHold(h1.holdId))?.status, 'ready');
  // H2 排队
  const h2 = await lib.placeHold('题名H', 'reader-2', 'branch-1');
  // H3 排队
  const h3 = await lib.placeHold('题名H', 'reader-3', 'branch-1');

  // 后来的预约不能抢走 H1 已绑定的册
  assert.equal((await lib.getHold(h1.holdId))?.status, 'ready');
  assert.equal((await lib.getHold(h1.holdId))?.barcode, 'BC-901');
  assert.equal((await lib.getHold(h2.holdId))?.status, 'pending');
  assert.equal((await lib.getHold(h3.holdId))?.status, 'pending');

  // H2 取消后重新预约：必须排到 H3 之后
  await lib.cancelHold(h2.holdId);
  const h2b = await lib.placeHold('题名H', 'reader-2', 'branch-1');
  const queue = (await lib.listHolds('题名H')).filter((h) => h.status !== 'cancelled');
  const order = queue.map((h) => h.holdId);
  assert.deepEqual(order, [h1.holdId, h3.holdId, h2b.holdId]);
  const seq2 = (await lib.getHold(h2.holdId))!.queueSeq;
  const seq2b = (await lib.getHold(h2b.holdId))!.queueSeq;
  const seq3 = (await lib.getHold(h3.holdId))!.queueSeq;
  assert.ok(seq2b > seq3 && seq3 > seq2, '重新预约的队列序号应排到队尾');
  lib.close();
});
