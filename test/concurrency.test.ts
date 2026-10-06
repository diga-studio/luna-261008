import test from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/index.js';

const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

/** 全局一致性核对：每册最多一条未完成预约或一次当前借出；去向与状态吻合。 */
function assertConsistent(lib: ShelfSync, barcodes: string[]): void {
  const seenReservationCopy = new Set<string>();
  for (const barcode of barcodes) {
    const copy = lib.getCopy(barcode)!;
    if (copy.reservationId !== null) {
      assert.ok(!seenReservationCopy.has(barcode), `copy ${barcode} bound twice`);
      seenReservationCopy.add(barcode);
      const res = lib.getReservation(copy.reservationId)!;
      assert.equal(res.copyBarcode, barcode);
      assert.ok(res.status === 'pending' || res.status === 'ready');
      if (res.status === 'ready') {
        assert.equal(copy.status, 'on_shelf');
        assert.equal(copy.branch, res.pickupBranch);
      }
    }
    if (copy.status === 'checked_out') {
      assert.ok(copy.loanCredential, 'checked out copy must have active loan');
      assert.equal(copy.reservationId, null);
    }
    if (copy.status === 'in_transit') {
      assert.ok(copy.transferCredential, 'in-transit copy must have active transfer');
      assert.ok(copy.transitTo, 'in-transit copy must have destination');
    }
    if (copy.status === 'on_shelf') {
      assert.equal(copy.transitTo, null);
      assert.equal(copy.loanCredential, null);
    }
  }
}

test('同一预约并发撤销与领取：只有一方成功，最终状态一致', async () => {
  for (let round = 0; round < 50; round++) {
    const lib = new ShelfSync(':memory:');
    try {
      lib.addCopy('题T', `BC-${round}`, 'A');
      const rid = lib.reserve('题T', 'u1', 'A');
      assert.equal(lib.getReservation(rid)!.status, 'ready');

      let cancelOk = false;
      let checkoutOk = false;
      let loan: string | null = null;
      const tryCancel = async () => {
        await yieldTick();
        try {
          lib.cancel(rid);
          cancelOk = true;
        } catch {
          /* 对方先完成 */
        }
      };
      const tryCheckout = async () => {
        await yieldTick();
        try {
          loan = lib.checkout(rid, 'u1', 'A');
          checkoutOk = true;
        } catch {
          /* 对方先完成 */
        }
      };
      await Promise.all([tryCancel(), tryCheckout()]);

      // 不得同时取消成功又借出成功。
      assert.notEqual(cancelOk && checkoutOk, true, `round ${round}: both succeeded`);
      assert.equal(cancelOk || checkoutOk, true, `round ${round}: neither succeeded`);

      const res = lib.getReservation(rid)!;
      const copy = lib.getCopy(`BC-${round}`)!;
      if (checkoutOk) {
        assert.equal(res.status, 'completed');
        assert.equal(copy.status, 'checked_out');
        assert.equal(copy.loanCredential, loan);
        // 已完成的预约不能再撤销。
        assert.throws(() => lib.cancel(rid), /already completed/);
      } else {
        assert.equal(res.status, 'cancelled');
        assert.equal(copy.status, 'on_shelf');
        assert.equal(copy.reservationId, null);
        // 已撤销预约不能凭旧信息领取。
        assert.throws(() => lib.checkout(rid, 'u1', 'A'), /not ready/);
      }
      assertConsistent(lib, [`BC-${round}`]);
    } finally {
      lib.close();
    }
  }
});

test('已撤销预约不能领取后来分配给别人的同一册', () => {
  const lib = new ShelfSync(':memory:');
  try {
    lib.addCopy('题T', 'BC-200', 'A');
    const r1 = lib.reserve('题T', 'u1', 'A');
    assert.equal(lib.getReservation(r1)!.status, 'ready');
    lib.cancel(r1);

    const r2 = lib.reserve('题T', 'u2', 'A');
    assert.equal(lib.getReservation(r2)!.copyBarcode, 'BC-200');

    // 旧预约信息已失效。
    assert.throws(() => lib.checkout(r1, 'u1', 'A'), /not ready/);
    // 非绑定读者不能领取。
    assert.throws(() => lib.checkout(r2, 'u1', 'A'), /another reader/);
    // 必须在领取分馆领取。
    assert.throws(() => lib.checkout(r2, 'u2', 'B'), /picked up at A/);

    const loan = lib.checkout(r2, 'u2', 'A');
    assert.equal(lib.getCopy('BC-200')!.loanCredential, loan);
    assert.equal(lib.getReservation(r2)!.status, 'completed');
    assertConsistent(lib, ['BC-200']);
  } finally {
    lib.close();
  }
});

test('并发办理混合序列：结果等价于逐笔办理且保持一致', async () => {
  const lib = new ShelfSync(':memory:');
  try {
    const barcodes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const barcode = `BC-M${i}`;
      lib.addCopy('题T', barcode, i % 2 === 0 ? 'A' : 'B');
      barcodes.push(barcode);
    }
    const reservationIds: number[] = [];
    const loans: string[] = [];
    const transfers = new Set<string>();

    const tasks: Array<() => Promise<void>> = [];
    for (let i = 0; i < 30; i++) {
      tasks.push(async () => {
        await yieldTick();
        reservationIds.push(lib.reserve('题T', `u${i}`, i % 3 === 0 ? 'B' : 'A'));
      });
    }
    // 交错执行：预约、领取、撤销、入馆、轮询去向。
    for (let i = 0; i < 30; i++) {
      tasks.push(async () => {
        await yieldTick();
        const rid = reservationIds[i];
        if (rid === undefined) return;
        const res = lib.getReservation(rid)!;
        if (res.status === 'ready' && i % 2 === 0) {
          try {
            loans.push(lib.checkout(rid, res.reader, res.pickupBranch));
          } catch {
            /* 竞争失败 */
          }
        } else if (i % 5 === 0) {
          try {
            lib.cancel(rid);
          } catch {
            /* 竞争失败 */
          }
        }
      });
      tasks.push(async () => {
        await yieldTick();
        for (const barcode of barcodes) {
          const copy = lib.getCopy(barcode)!;
          if (copy.transferCredential) transfers.add(copy.transferCredential);
        }
        // 随机抽取一笔已到馆的调拨或借出办理入馆。
        for (const credential of transfers) {
          const t = lib.getTransfer(credential);
          if (t && !t.arrived) {
            lib.checkin(credential, t.toBranch);
            break;
          }
        }
        const loan = loans[0];
        if (loan) {
          lib.checkin(loan, 'A');
          loans.shift();
        }
      });
    }
    await Promise.all(tasks.map((task) => task()));

    assertConsistent(lib, barcodes);
    // 队列查询不暴露半完成状态：每条未完成预约的绑定都互相吻合。
    for (const entry of lib.listQueue('题T')) {
      if (entry.copyBarcode) {
        assert.equal(lib.getCopy(entry.copyBarcode)!.reservationId, entry.id);
      }
    }
  } finally {
    lib.close();
  }
});
