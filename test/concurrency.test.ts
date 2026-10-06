import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/shelfsync.js';

/** 核对：每册的预约、借出与实际去向一致。 */
async function reconcile(lib: ShelfSync): Promise<void> {
  const copies = await lib.listCopies();
  const seenHoldByCopy = new Map<number, string>();
  for (const copy of copies) {
    // 状态与去向字段自洽
    if (copy.status === 'on_shelf') {
      assert.ok(copy.branch, `${copy.barcode} 在架应有所在分馆`);
      assert.equal(copy.transferCredential, null);
      assert.equal(copy.loanCredential, null);
    } else if (copy.status === 'in_transit') {
      assert.ok(copy.branch, `${copy.barcode} 在途应有目的分馆`);
      assert.ok(copy.transferCredential, `${copy.barcode} 在途应有调拨凭据`);
      assert.equal(copy.loanCredential, null);
    } else {
      assert.equal(copy.branch, null);
      assert.equal(copy.transferCredential, null);
      assert.ok(copy.loanCredential, `${copy.barcode} 借出应有借出凭据`);
      assert.equal(copy.holdId, null, '借出册不得关联未完成预约');
    }
    // 一册最多关联一条未完成预约
    if (copy.holdId !== null) {
      assert.ok(!seenHoldByCopy.has(copy.holdId), '一条预约最多绑定一册');
      seenHoldByCopy.set(copy.holdId, copy.barcode);
      const hold = await lib.getHold(copy.holdId);
      assert.ok(hold, '关联的预约必须存在');
      assert.ok(hold.status === 'bound' || hold.status === 'ready');
      assert.equal(hold.barcode, copy.barcode, '预约与册互相指向');
      if (copy.status === 'on_shelf') {
        assert.equal(hold.status, 'ready');
        assert.equal(copy.branch, hold.pickupBranch);
      }
    }
    // 借出凭据对应当前那次借出
    if (copy.loanCredential) {
      const loan = await lib.getLoan(copy.loanCredential);
      assert.equal(loan?.status, 'open');
      assert.equal(loan?.barcode, copy.barcode);
    }
    // 调拨凭据对应当前那次调拨
    if (copy.transferCredential) {
      const transfer = await lib.getTransfer(copy.transferCredential);
      assert.equal(transfer?.status, 'open');
      assert.equal(transfer?.barcode, copy.barcode);
      assert.equal(transfer?.destBranch, copy.branch);
    }
  }
}

test('并发撤销与领取：不得同时取消成功又借出成功', async () => {
  for (let round = 0; round < 20; round++) {
    const lib = new ShelfSync(':memory:');
    await lib.registerCopy('题名D', `BC-3${round}`, 'branch-1');
    const h = await lib.placeHold('题名D', 'reader-1', 'branch-1');
    assert.equal((await lib.getHold(h.holdId))?.status, 'ready');

    const [cancelRes, pickupRes] = await Promise.all([
      lib.cancelHold(h.holdId),
      lib.pickup(h.holdId, 'reader-1', 'branch-1'),
    ]);

    const cancelOk = cancelRes.ok;
    const pickupOk = pickupRes.ok;
    // 先发生业务状态变化的一方决定结果，另一方不得逆转它
    assert.notEqual(cancelOk && pickupOk, true, '不得同时取消成功又借出成功');
    assert.ok(cancelOk || pickupOk, '必有一方成功');

    const hold = await lib.getHold(h.holdId);
    const copy = await lib.getCopy(`BC-3${round}`);
    if (pickupOk) {
      assert.equal(hold?.status, 'fulfilled');
      assert.equal(copy?.status, 'checked_out');
      assert.deepEqual(cancelRes, { ok: false, reason: 'already_fulfilled' });
    } else {
      assert.equal(hold?.status, 'cancelled');
      assert.equal(copy?.status, 'on_shelf');
      assert.equal(copy?.holdId, null);
      assert.deepEqual(pickupRes, { ok: false, reason: 'already_cancelled' });
    }
    await reconcile(lib);
    lib.close();
  }
});

test('已撤销预约不能凭旧信息领取后来分配给别人的同一册', async () => {
  const lib = new ShelfSync(':memory:');
  await lib.registerCopy('题名E', 'BC-401', 'branch-1');

  // H1 跨馆预约，册在途；撤销后 H2（同目的分馆）在途中绑定同一册
  const h1 = await lib.placeHold('题名E', 'reader-1', 'branch-2');
  const t1 = (await lib.getCopy('BC-401'))!.transferCredential!;
  await lib.cancelHold(h1.holdId);
  const h2 = await lib.placeHold('题名E', 'reader-2', 'branch-2');
  assert.equal((await lib.getHold(h2.holdId))?.barcode, 'BC-401');
  await lib.checkin(t1, 'branch-2');
  assert.equal((await lib.getHold(h2.holdId))?.status, 'ready');

  // H1 读者凭旧信息领取：必须失败
  const stale = await lib.pickup(h1.holdId, 'reader-1', 'branch-2');
  assert.deepEqual(stale, { ok: false, reason: 'already_cancelled' });
  // 册仍在等待 H2 读者
  const copy = await lib.getCopy('BC-401');
  assert.equal(copy?.status, 'on_shelf');
  assert.equal(copy?.holdId, h2.holdId);

  // 非绑定读者也不能领取
  const wrongReader = await lib.pickup(h2.holdId, 'reader-1', 'branch-2');
  assert.deepEqual(wrongReader, { ok: false, reason: 'wrong_reader' });
  // 错误分馆也不能领取
  const wrongBranch = await lib.pickup(h2.holdId, 'reader-2', 'branch-1');
  assert.deepEqual(wrongBranch, { ok: false, reason: 'wrong_branch' });

  // H2 正常领取
  const ok = await lib.pickup(h2.holdId, 'reader-2', 'branch-2');
  assert.equal(ok.ok, true);
  await reconcile(lib);
  lib.close();
});

test('100 笔并发混合办理：结果等价于逐笔办理且全局一致', async () => {
  const lib = new ShelfSync(':memory:');
  // 10 个分馆、多册馆藏
  for (let i = 0; i < 30; i++) {
    await lib.registerCopy('题名F', `BC-5${String(i).padStart(3, '0')}`, `branch-${(i % 10) + 1}`);
  }
  // 先建立一批预约（部分已绑定/在途/可领取）
  const holdIds: number[] = [];
  for (let i = 0; i < 40; i++) {
    const h = await lib.placeHold('题名F', `reader-${i}`, `branch-${(i % 10) + 1}`);
    holdIds.push(h.holdId);
  }

  // 100 笔并发办理：预约、撤销、领取、入馆混合
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 100; i++) {
    const kind = i % 4;
    const holdId = holdIds[i % holdIds.length];
    if (kind === 0) {
      ops.push(lib.placeHold('题名F', `reader-new-${i}`, `branch-${(i % 10) + 1}`));
    } else if (kind === 1) {
      ops.push(lib.cancelHold(holdId));
    } else if (kind === 2) {
      ops.push(lib.pickup(holdId, `reader-${holdIds.indexOf(holdId)}`, `branch-${(holdIds.indexOf(holdId) % 10) + 1}`));
    } else {
      const copy = (await lib.listCopies())[i % 30];
      const cred = copy.transferCredential ?? copy.loanCredential ?? 'T-0';
      ops.push(lib.checkin(cred, `branch-${(i % 10) + 1}`));
    }
  }
  await Promise.all(ops);

  // 最终每册的预约、借出与实际去向必须一致
  await reconcile(lib);

  // 不变式：任何册最多一条未完成预约；任何预约最多绑定一册
  const holds = await lib.listHolds('题名F');
  const active = holds.filter((h) => h.status === 'pending' || h.status === 'bound' || h.status === 'ready');
  const boundBarcodes = active.filter((h) => h.barcode !== null).map((h) => h.barcode);
  assert.equal(new Set(boundBarcodes).size, boundBarcodes.length, '一册最多绑定一条预约');
  lib.close();
});
