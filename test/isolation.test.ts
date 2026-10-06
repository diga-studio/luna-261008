import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DeliveryLibrary } from "../src/index";
import { DeliverMock, flush, tmpDbPath } from "./helpers";

test("一个会话的慢投递不阻塞其他会话", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("slow", "m1", "drag");
  lib.enqueue("fast", "m1", "quick");
  lib.setOnline("slow", true);
  lib.setOnline("fast", true);
  lib.pump(1000);
  assert.equal(mock.callsFor("slow", 1).length, 1);
  assert.equal(mock.callsFor("fast", 1).length, 1);

  // slow 的投递一直不结束；fast 的重试、新消息投递、ACK 照常进行
  mock.callsFor("fast", 1)[0].reject(new Error("boom"));
  await flush();
  lib.enqueue("fast", "m2", "more");
  lib.pump(6000);
  assert.equal(mock.callsFor("fast", 1).length, 2, "fast 到期重试");
  assert.equal(mock.callsFor("fast", 2).length, 1, "fast 新消息首次投递");
  lib.acknowledge("fast", 1);
  lib.acknowledge("fast", 2);
  lib.close();
});

test("deliver 同步抛错按失败处理并占用额度", async () => {
  let calls = 0;
  const dbPath = tmpDbPath();
  const lib = new DeliveryLibrary(dbPath, () => {
    calls += 1;
    throw new Error("sync throw");
  });
  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  lib.pump(1000); // 同步抛错：第 1 次尝试
  lib.pump(2000); // 未到期
  lib.pump(6000); // 第 2 次尝试
  lib.pump(11_000); // 第 3 次
  lib.pump(16_000); // 第 4 次，耗尽
  lib.pump(100_000); // 不再重试
  assert.equal(calls, 4);
  lib.close();

  // 消息未因额度耗尽而消失：重开上线后仍补发
  const mock2 = new DeliverMock();
  const lib2 = new DeliveryLibrary(dbPath, mock2.fn);
  lib2.setOnline("c1", true);
  lib2.pump(200_000);
  assert.equal(mock2.callsFor("c1", 1).length, 1);
  lib2.close();
});
