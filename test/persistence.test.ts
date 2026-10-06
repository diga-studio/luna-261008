import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShelfSync } from '../src/index.js';

test('正常关闭并重新打开后，预约、借出和在途状态保持一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelfsync-'));
  const dbPath = join(dir, 'state.db');
  let loan = '';
  let transfer = '';
  let readyId = 0;
  let transitResId = 0;
  try {
    {
      const lib = new ShelfSync(dbPath);
      lib.addCopy('题T', 'BC-P1', 'A');
      lib.addCopy('题T', 'BC-P2', 'A');
      lib.addCopy('题T', 'BC-P3', 'B');
      // 一笔借出。
      const r1 = lib.reserve('题T', 'u1', 'B'); // BC-P3 在 B 在架 -> ready
      readyId = r1;
      // 一笔在途。
      const r2 = lib.reserve('题T', 'u2', 'B'); // 调拨 A->B，字典序 BC-P1
      transitResId = r2;
      transfer = lib.getCopy('BC-P1')!.transferCredential!;
      // 一笔借出完成：用 BC-P2。
      const r3 = lib.reserve('题T', 'u3', 'A'); // BC-P2 ready
      loan = lib.checkout(r3, 'u3', 'A');
      // 一条排队中的预约。
      lib.reserve('题T', 'u4', 'A');
      lib.close();
    }
    {
      const lib = new ShelfSync(dbPath);
      // 在途状态保持。
      const inTransit = lib.getCopy('BC-P1')!;
      assert.equal(inTransit.status, 'in_transit');
      assert.equal(inTransit.transitTo, 'B');
      assert.equal(inTransit.transferCredential, transfer);
      assert.equal(inTransit.reservationId, transitResId);
      // 借出状态保持。
      const lent = lib.getCopy('BC-P2')!;
      assert.equal(lent.status, 'checked_out');
      assert.equal(lent.loanCredential, loan);
      // 可领取预约保持。
      assert.equal(lib.getReservation(readyId)!.status, 'ready');
      // 队列保持（按接受先后）。
      const queue = lib.listQueue('题T');
      assert.deepEqual(
        queue.map((q) => q.id),
        [readyId, transitResId, 4],
      );
      // 重开后业务可继续：在途到馆、借出归还、领取。
      lib.checkin(transfer, 'B');
      assert.equal(lib.getReservation(transitResId)!.status, 'ready');
      lib.checkin(loan, 'B'); // 任意分馆归还
      assert.equal(lib.getCopy('BC-P2')!.branch, 'B');
      const newLoan = lib.checkout(readyId, 'u1', 'B');
      assert.equal(lib.getCopy('BC-P3')!.loanCredential, newLoan);
      lib.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
