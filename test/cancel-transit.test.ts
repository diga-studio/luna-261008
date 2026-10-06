import test from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/index.js';

test('撤销在途预约、重新绑定、到馆后再次调拨的完整过程', () => {
  const lib = new ShelfSync(':memory:');
  try {
    lib.addCopy('题T', 'BC-100', 'A');
    const r1 = lib.reserve('题T', 'u1', 'B');
    const copy1 = lib.getCopy('BC-100')!;
    assert.equal(copy1.status, 'in_transit');
    assert.equal(copy1.transitTo, 'B');
    const transfer1 = copy1.transferCredential!;

    // 撤销在途预约：解除绑定，但册仍沿原调拨运往 B，不能改道。
    lib.cancel(r1);
    const afterCancel = lib.getCopy('BC-100')!;
    assert.equal(afterCancel.status, 'in_transit');
    assert.equal(afterCancel.transitTo, 'B');
    assert.equal(afterCancel.reservationId, null);
    assert.equal(afterCancel.transferCredential, transfer1);
    assert.equal(lib.getReservation(r1)!.status, 'cancelled');

    // 在途中绑定同一目的分馆 B 的新预约。
    const r2 = lib.reserve('题T', 'u2', 'B');
    assert.equal(lib.getReservation(r2)!.copyBarcode, 'BC-100');
    assert.equal(lib.getCopy('BC-100')!.reservationId, r2);
    // 不产生新调拨。
    assert.equal(lib.getCopy('BC-100')!.transferCredential, transfer1);

    // 到馆：r2 进入可领取状态。
    lib.checkin(transfer1, 'B');
    assert.equal(lib.getReservation(r2)!.status, 'ready');
    assert.equal(lib.getCopy('BC-100')!.status, 'on_shelf');
    assert.equal(lib.getCopy('BC-100')!.branch, 'B');
  } finally {
    lib.close();
  }
});

test('到馆时无绑定预约则重新参与分配并产生下一次调拨', () => {
  const lib = new ShelfSync(':memory:');
  try {
    lib.addCopy('题T', 'BC-101', 'A');
    const r1 = lib.reserve('题T', 'u1', 'B');
    const transfer1 = lib.getCopy('BC-101')!.transferCredential!;
    lib.cancel(r1);

    // 排队一个要去 C 的预约：在途目的为 B，不兼容，只能等到馆。
    const r3 = lib.reserve('题T', 'u3', 'C');
    assert.equal(lib.getReservation(r3)!.copyBarcode, null);

    // 到馆 B 后作为 B 的在架册重新分配：绑定 r3 并产生 B->C 的新调拨。
    lib.checkin(transfer1, 'B');
    const copy = lib.getCopy('BC-101')!;
    assert.equal(copy.status, 'in_transit');
    assert.equal(copy.transitTo, 'C');
    assert.equal(copy.branch, 'B');
    assert.equal(copy.reservationId, r3);
    const transfer2 = copy.transferCredential!;
    assert.notEqual(transfer2, transfer1);

    // 旧调拨凭据重复到达：不改变新状态。
    lib.checkin(transfer1, 'B');
    const afterStale = lib.getCopy('BC-101')!;
    assert.equal(afterStale.status, 'in_transit');
    assert.equal(afterStale.transitTo, 'C');
    assert.equal(afterStale.transferCredential, transfer2);
    assert.equal(lib.getTransfer(transfer1)!.arrived, true);

    // 新调拨到馆，r3 可领取。
    lib.checkin(transfer2, 'C');
    assert.equal(lib.getReservation(r3)!.status, 'ready');
    assert.equal(lib.getCopy('BC-101')!.status, 'on_shelf');
    assert.equal(lib.getCopy('BC-101')!.branch, 'C');
  } finally {
    lib.close();
  }
});

test('旧借出凭据在册再次借出后不能使其重新入馆', () => {
  const lib = new ShelfSync(':memory:');
  try {
    lib.addCopy('题T', 'BC-102', 'A');
    const r1 = lib.reserve('题T', 'u1', 'A');
    const loan1 = lib.checkout(r1, 'u1', 'A');
    lib.checkin(loan1, 'A');
    assert.equal(lib.getCopy('BC-102')!.status, 'on_shelf');

    // 重复归还同一凭据：无操作。
    lib.checkin(loan1, 'A');
    assert.equal(lib.getCopy('BC-102')!.status, 'on_shelf');

    // 同一册再次借出，得到新凭据。
    const r2 = lib.reserve('题T', 'u2', 'A');
    const loan2 = lib.checkout(r2, 'u2', 'A');
    assert.notEqual(loan2, loan1);
    assert.equal(lib.getCopy('BC-102')!.status, 'checked_out');
    assert.equal(lib.getCopy('BC-102')!.loanCredential, loan2);

    // 旧借出凭据再到达：不能使册重新入馆。
    lib.checkin(loan1, 'A');
    const copy = lib.getCopy('BC-102')!;
    assert.equal(copy.status, 'checked_out');
    assert.equal(copy.loanCredential, loan2);

    // 未知凭据：无操作。
    lib.checkin('no-such-credential', 'A');
    assert.equal(lib.getCopy('BC-102')!.status, 'checked_out');

    // 当前凭据正常归还。
    lib.checkin(loan2, 'A');
    assert.equal(lib.getCopy('BC-102')!.status, 'on_shelf');
  } finally {
    lib.close();
  }
});

test('调拨必须在目的分馆办理到馆', () => {
  const lib = new ShelfSync(':memory:');
  try {
    lib.addCopy('题T', 'BC-103', 'A');
    lib.reserve('题T', 'u1', 'B');
    const transfer = lib.getCopy('BC-103')!.transferCredential!;
    assert.throws(() => lib.checkin(transfer, 'C'), /must be checked in at B/);
    // 状态未变。
    assert.equal(lib.getCopy('BC-103')!.status, 'in_transit');
    lib.checkin(transfer, 'B');
    assert.equal(lib.getCopy('BC-103')!.status, 'on_shelf');
  } finally {
    lib.close();
  }
});
