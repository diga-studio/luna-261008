import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/shelfsync.js';

test('撤销在途预约→重新绑定→到馆→再次调拨→借出归还，旧凭据不改变新状态', async () => {
  const lib = new ShelfSync(':memory:');
  await lib.registerCopy('题名C', 'BC-201', 'branch-1');

  // H1 跨馆预约：产生调拨 T1，册在途运往 branch-2
  const h1 = await lib.placeHold('题名C', 'reader-1', 'branch-2');
  let copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-2');
  const t1 = copy!.transferCredential!;
  assert.ok(t1);

  // 撤销在途预约：解除绑定，但册仍沿原调拨到馆，不改道
  const c1 = await lib.cancelHold(h1.holdId);
  assert.deepEqual(c1, { ok: true });
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-2');
  assert.equal(copy?.holdId, null);
  assert.equal(copy?.transferCredential, t1);
  const t1Info = await lib.getTransfer(t1);
  assert.equal(t1Info?.status, 'open');
  assert.equal(t1Info?.holdId, null);

  // 同一目的分馆的新预约 H2：在途中重新绑定，调拨凭据不变
  const h2 = await lib.placeHold('题名C', 'reader-2', 'branch-2');
  const hold2 = await lib.getHold(h2.holdId);
  assert.equal(hold2?.status, 'bound');
  assert.equal(hold2?.barcode, 'BC-201');
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.transferCredential, t1);
  assert.equal((await lib.getTransfer(t1))?.holdId, h2.holdId);

  // 到馆：凭 T1 入馆，H2 进入可领取状态
  const ci1 = await lib.checkin(t1, 'branch-2');
  assert.deepEqual(ci1, { ok: true, kind: 'transfer' });
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'on_shelf');
  assert.equal(copy?.branch, 'branch-2');
  assert.equal((await lib.getHold(h2.holdId))?.status, 'ready');

  // 重复办理已完成的凭据：不改变状态
  const ci1dup = await lib.checkin(t1, 'branch-2');
  assert.deepEqual(ci1dup, { ok: false, reason: 'already_closed' });
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'on_shelf');
  assert.equal(copy?.branch, 'branch-2');

  // 撤销 H2：册成为 branch-2 的在架空闲册
  await lib.cancelHold(h2.holdId);
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'on_shelf');
  assert.equal(copy?.branch, 'branch-2');
  assert.equal(copy?.holdId, null);

  // 新预约 H3（branch-3）：到馆后的在架册再次调拨，产生新凭据 T2
  const h3 = await lib.placeHold('题名C', 'reader-3', 'branch-3');
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-3');
  const t2 = copy!.transferCredential!;
  assert.ok(t2);
  assert.notEqual(t2, t1);

  // 旧调拨凭据 T1 再次到达：不能使册重新入馆或改状态
  const ciOld = await lib.checkin(t1, 'branch-2');
  assert.deepEqual(ciOld, { ok: false, reason: 'already_closed' });
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-3');

  // T2 到馆，H3 可领取；领取形成借出记录 L1
  await lib.checkin(t2, 'branch-3');
  const p = await lib.pickup(h3.holdId, 'reader-3', 'branch-3');
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const l1 = p.loanCredential;
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'checked_out');
  assert.equal(copy?.branch, null);
  assert.equal(copy?.loanCredential, l1);
  assert.equal((await lib.getHold(h3.holdId))?.status, 'fulfilled');

  // 在任意分馆归还（branch-5）：成为该馆在架册
  const ciLoan = await lib.checkin(l1, 'branch-5');
  assert.deepEqual(ciLoan, { ok: true, kind: 'loan' });
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'on_shelf');
  assert.equal(copy?.branch, 'branch-5');
  assert.equal(copy?.loanCredential, null);

  // 重复归还：不改变状态
  const ciLoanDup = await lib.checkin(l1, 'branch-5');
  assert.deepEqual(ciLoanDup, { ok: false, reason: 'already_closed' });

  // 册进入后续调拨后，旧借出凭据再到达也不能使它重新入馆
  const h4 = await lib.placeHold('题名C', 'reader-4', 'branch-6');
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-6');
  const ciStaleLoan = await lib.checkin(l1, 'branch-5');
  assert.deepEqual(ciStaleLoan, { ok: false, reason: 'already_closed' });
  copy = await lib.getCopy('BC-201');
  assert.equal(copy?.status, 'in_transit');
  assert.equal(copy?.branch, 'branch-6');
  assert.equal(copy?.holdId, h4.holdId);

  // 未知凭据
  const ciUnknown = await lib.checkin('T-999999', 'branch-1');
  assert.deepEqual(ciUnknown, { ok: false, reason: 'unknown_credential' });
  lib.close();
});
