import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/shelfsync.js';

test('正常关闭并重新打开后，预约、借出和在途状态保持一致', async () => {
  const path = `/private/tmp/shelfsync-persist-${Date.now()}.db`;

  let transferCredential = '';
  let loanCredential = '';
  let h1Id = 0;
  let h2Id = 0;
  let h3Id = 0;
  {
    const lib = new ShelfSync(path);
    await lib.registerCopy('题名G', 'BC-701', 'branch-1');
    await lib.registerCopy('题名G', 'BC-702', 'branch-1');
    // H1：领取分馆 branch-2，无本馆册，BC-701 调拨在途
    const h1 = await lib.placeHold('题名G', 'reader-1', 'branch-2');
    h1Id = h1.holdId;
    // H2：本馆在架（BC-702 @ branch-1），可领取
    const h2 = await lib.placeHold('题名G', 'reader-2', 'branch-1');
    h2Id = h2.holdId;
    // H3：无空闲册可用，排队
    const h3 = await lib.placeHold('题名G', 'reader-3', 'branch-4');
    h3Id = h3.holdId;
    assert.equal((await lib.getHold(h1Id))?.status, 'bound');
    assert.equal((await lib.getHold(h2Id))?.status, 'ready');
    assert.equal((await lib.getHold(h3Id))?.status, 'pending');
    // H2 领取，形成借出
    const p = await lib.pickup(h2Id, 'reader-2', 'branch-1');
    assert.equal(p.ok, true);
    if (p.ok) loanCredential = p.loanCredential;
    transferCredential = (await lib.getCopy('BC-701'))!.transferCredential!;
    lib.close();
  }

  {
    const lib = new ShelfSync(path);
    // 在途状态保持
    const inTransit = await lib.getCopy('BC-701');
    assert.equal(inTransit?.status, 'in_transit');
    assert.equal(inTransit?.branch, 'branch-2');
    assert.equal(inTransit?.transferCredential, transferCredential);
    assert.equal(inTransit?.holdId, h1Id);
    const h1 = await lib.getHold(h1Id);
    assert.equal(h1?.status, 'bound');
    assert.equal(h1?.barcode, 'BC-701');
    // 借出状态保持
    const checkedOut = await lib.getCopy('BC-702');
    assert.equal(checkedOut?.status, 'checked_out');
    assert.equal(checkedOut?.loanCredential, loanCredential);
    const loan = await lib.getLoan(loanCredential);
    assert.equal(loan?.status, 'open');
    assert.equal(loan?.reader, 'reader-2');
    // 排队状态保持
    const h3 = await lib.getHold(h3Id);
    assert.equal(h3?.status, 'pending');

    // 重开后业务继续：调拨到馆，H1 可领取
    const ci = await lib.checkin(transferCredential, 'branch-2');
    assert.deepEqual(ci, { ok: true, kind: 'transfer' });
    assert.equal((await lib.getHold(h1Id))?.status, 'ready');

    // 归还在 branch-3 入馆：BC-702 在架空闲，分配给排队的 H3 并产生新调拨
    const ciLoan = await lib.checkin(loanCredential, 'branch-3');
    assert.deepEqual(ciLoan, { ok: true, kind: 'loan' });
    const copy702 = await lib.getCopy('BC-702');
    assert.equal(copy702?.status, 'in_transit');
    assert.equal(copy702?.branch, 'branch-4');
    assert.equal(copy702?.holdId, h3Id);
    // 凭据序号重启后延续、不复用
    assert.ok(copy702?.transferCredential);
    assert.notEqual(copy702?.transferCredential, transferCredential);
    assert.notEqual(copy702?.transferCredential, loanCredential);
    lib.close();
  }
});
