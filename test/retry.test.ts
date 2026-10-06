import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DeliveryLibrary } from "../src/index";
import { DeliverMock, flush, tmpDbPath } from "./helpers";

test("失败后 5000ms 才允许重试，提前 pump 不发起", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  lib.pump(1000);
  assert.equal(mock.calls.length, 1);
  mock.calls[0].reject(new Error("boom"));
  await flush();

  lib.pump(5999); // 距上次发起不足 5000ms
  assert.equal(mock.calls.length, 1);
  lib.pump(6000); // 恰好到期
  assert.equal(mock.calls.length, 2);
  lib.close();
});

test("首次投递加最多 3 次重试，失败调用占额度，耗尽后保留但不主动重试", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  for (let round = 0; round < 4; round++) {
    lib.pump(round * 5000);
    assert.equal(mock.calls.length, round + 1, `round ${round}`);
    mock.calls[round].reject(new Error("boom"));
    await flush();
  }
  // 额度耗尽：不再主动重试
  lib.pump(100_000);
  lib.pump(1_000_000);
  assert.equal(mock.calls.length, 4);
  lib.close();
});

test("额度耗尽的消息在重连后获得新额度并补发", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  for (let round = 0; round < 4; round++) {
    lib.pump(round * 5000);
    mock.calls[round].reject(new Error("boom"));
    await flush();
  }
  assert.equal(mock.calls.length, 4);

  lib.setOnline("c1", false);
  lib.setOnline("c1", true);
  lib.pump(200_000);
  assert.equal(mock.calls.length, 5); // 新一轮首次补发
  lib.close();
});

test("重复 setOnline(true) 不重置额度", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  lib.pump(0);
  mock.calls[0].reject(new Error("boom"));
  await flush();
  lib.setOnline("c1", true); // 重复设置：无副作用
  lib.setOnline("c1", true);
  lib.pump(10_000); // 距发起已超 5000ms，若被重置会立即重发为首次投递
  assert.equal(mock.calls.length, 2); // 只是到期重试，不是额度重置
  mock.calls[1].reject(new Error("boom"));
  await flush();
  lib.setOnline("c1", true);
  lib.pump(20_000); // 第 3 次尝试（距 10000 已超过 5000）
  assert.equal(mock.calls.length, 3);
  mock.calls[2].reject(new Error("boom"));
  await flush();
  lib.pump(30_000); // 第 4 次尝试，随后耗尽
  assert.equal(mock.calls.length, 4);
  mock.calls[3].reject(new Error("boom"));
  await flush();
  lib.pump(100_000);
  assert.equal(mock.calls.length, 4);
  lib.close();
});

test("未确认的旧消息不阻止后续新消息首次投递", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "old");
  lib.setOnline("c1", true);
  lib.pump(0);
  assert.equal(mock.calls.length, 1);
  mock.calls[0].resolve(); // 投递成功但未 ACK

  lib.enqueue("c1", "m2", "new");
  lib.pump(1000); // 旧消息未到期也不应阻塞新消息
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].seq, 2);
  lib.close();
});
