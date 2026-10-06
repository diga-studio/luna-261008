import test from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/index.js';

test('较早的跨馆预约优先于较晚的本馆预约', () => {
  const lib = new ShelfSync(':memory:');
  try {
    // 册在 A 馆，先被借出，使后续两个预约都排队等待。
    lib.addCopy('题T', 'BC-001', 'A');
    const r0 = lib.reserve('题T', 'u0', 'A');
    const loan0 = lib.checkout(r0, 'u0', 'A');

    // r1 较早、跨馆（领取馆 B）；r2 较晚、本馆（领取馆 A）。
    const r1 = lib.reserve('题T', 'u1', 'B');
    const r2 = lib.reserve('题T', 'u2', 'A');
    assert.equal(lib.getReservation(r1)!.copyBarcode, null);
    assert.equal(lib.getReservation(r2)!.copyBarcode, null);

    // 册归还到 A 馆：按排队顺序 r1 先匹配，即使它要跨馆调拨。
    lib.checkin(loan0, 'A');

    const res1 = lib.getReservation(r1)!;
    const res2 = lib.getReservation(r2)!;
    assert.equal(res1.copyBarcode, 'BC-001');
    assert.equal(res1.status, 'pending'); // 在途，未到馆不可领取
    assert.equal(res2.copyBarcode, null);
    assert.equal(res2.status, 'pending');

    const copy = lib.getCopy('BC-001')!;
    assert.equal(copy.status, 'in_transit');
    assert.equal(copy.transitTo, 'B');
    assert.equal(copy.reservationId, r1);

    // 调拨到馆后 r1 可领取，r2 仍在等待。
    lib.checkin(copy.transferCredential!, 'B');
    assert.equal(lib.getReservation(r1)!.status, 'ready');
    assert.equal(lib.getCopy('BC-001')!.status, 'on_shelf');
    assert.equal(lib.getCopy('BC-001')!.branch, 'B');
  } finally {
    lib.close();
  }
});

test('只有空闲在途册时，不兼容的队首可被跳过', () => {
  const lib = new ShelfSync(':memory:');
  try {
    // 让册进入“无绑定的在途”状态：先产生调拨再撤销预约。
    lib.addCopy('题T', 'BC-002', 'A');
    const r0 = lib.reserve('题T', 'u0', 'X');
    const transfer = lib.getCopy('BC-002')!;
    assert.equal(transfer.status, 'in_transit');
    assert.equal(transfer.transitTo, 'X');
    lib.cancel(r0);
    assert.equal(lib.getCopy('BC-002')!.reservationId, null);
    assert.equal(lib.getCopy('BC-002')!.status, 'in_transit');

    // 队首 r1 要去 Y 馆，与在途目的 X 不兼容；r2 要去 X 馆。
    const r1 = lib.reserve('题T', 'u1', 'Y');
    assert.equal(lib.getReservation(r1)!.copyBarcode, null);
    const r2 = lib.reserve('题T', 'u2', 'X');

    // r1 被跳过，r2 绑定该在途册；册的目的分馆不变。
    assert.equal(lib.getReservation(r1)!.copyBarcode, null);
    const res2 = lib.getReservation(r2)!;
    assert.equal(res2.copyBarcode, 'BC-002');
    assert.equal(res2.status, 'pending');
    const copy = lib.getCopy('BC-002')!;
    assert.equal(copy.status, 'in_transit');
    assert.equal(copy.transitTo, 'X');
    assert.equal(copy.reservationId, r2);

    // 到馆后 r2 可领取；r1 仍等待。
    lib.checkin(copy.transferCredential!, 'X');
    assert.equal(lib.getReservation(r2)!.status, 'ready');
    assert.equal(lib.getReservation(r1)!.copyBarcode, null);
  } finally {
    lib.close();
  }
});

test('同预约多册可选时按优先级与条码字典序选择', () => {
  const lib = new ShelfSync(':memory:');
  try {
    // 领取馆 B：B 在架一册、A 在架两册、另有一册正运往 B。
    lib.addCopy('题T', 'BC-A2', 'A');
    lib.addCopy('题T', 'BC-A1', 'A');
    lib.addCopy('题T', 'BC-B1', 'B');
    lib.addCopy('题T', 'BC-C1', 'C');
    const r0 = lib.reserve('题T', 'u0', 'B'); // 触发 BC-C1 调拨 C->B 后撤销，造出在途册
    assert.equal(lib.getReservation(r0)!.copyBarcode, 'BC-B1'); // B 在架优先
    lib.cancel(r0); // BC-B1 重新空闲

    // 制造正运往 B 的空闲在途册 BC-C1。
    const r1 = lib.reserve('题T', 'u1', 'B');
    assert.equal(lib.getReservation(r1)!.copyBarcode, 'BC-B1');
    lib.cancel(r1);
    // 现在 BC-B1 在架空闲，BC-A1/BC-A2 在架空闲。再让 BC-C1 上路：
    const r2 = lib.reserve('题T', 'u2', 'B');
    assert.equal(lib.getReservation(r2)!.copyBarcode, 'BC-B1');
    lib.cancel(r2);
    // 占掉 BC-B1、BC-A1、BC-A2，使下一预约只能用在途册。
    const hold1 = lib.reserve('题T', 'h1', 'B'); // -> BC-B1 ready
    const hold2 = lib.reserve('题T', 'h2', 'B'); // -> 调拨 BC-A1? 优先 B 在架无，次在途无，再 A 在架字典序 BC-A1
    const hold3 = lib.reserve('题T', 'h3', 'B'); // -> BC-A2
    assert.equal(lib.getReservation(hold1)!.copyBarcode, 'BC-B1');
    assert.equal(lib.getReservation(hold2)!.copyBarcode, 'BC-A1');
    assert.equal(lib.getReservation(hold3)!.copyBarcode, 'BC-A2');
    // 撤销 hold2，使 BC-A1 的调拨变成空闲在途（目的 B）。
    lib.cancel(hold2);
    assert.equal(lib.getCopy('BC-A1')!.status, 'in_transit');
    assert.equal(lib.getCopy('BC-A1')!.transitTo, 'B');
    assert.equal(lib.getCopy('BC-A1')!.reservationId, null);

    // 新预约：可选为“运往 B 的在途 BC-A1”（优先级 2），无 B 在架。
    const r3 = lib.reserve('题T', 'u3', 'B');
    assert.equal(lib.getReservation(r3)!.copyBarcode, 'BC-A1');

    // 再撤销，让 BC-A1 再次空闲在途；新增 C 在架册，验证在途优先于外馆在架。
    lib.cancel(r3);
    lib.addCopy('题T', 'BC-C9', 'C');
    const r4 = lib.reserve('题T', 'u4', 'B');
    assert.equal(lib.getReservation(r4)!.copyBarcode, 'BC-A1');

    // 同级按条码字典序：再验证外馆在架之间的选择。
    lib.cancel(r4);
    lib.checkin(lib.getCopy('BC-A1')!.transferCredential!, 'B'); // BC-A1 到 B 在架
    const hold4 = lib.reserve('题T', 'h4', 'B'); // 占掉 BC-A1（B 在架）
    assert.equal(lib.getReservation(hold4)!.copyBarcode, 'BC-A1');
    const r5 = lib.reserve('题T', 'u5', 'B'); // 外馆在架 BC-C1 与 BC-C9，同级按条码字典序选 BC-C1
    assert.equal(lib.getReservation(r5)!.copyBarcode, 'BC-C1');
  } finally {
    lib.close();
  }
});
