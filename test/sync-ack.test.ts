import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DeliveryLibrary } from "../src/index";
import { DeliverMock, flush, tmpDbPath } from "./helpers";

// 必测场景 1：deliver 同步确认消息后返回一个尚未完成的 Promise；
// 继续投递后续消息，再让该 Promise 失败，原消息不得再次发送。
test("deliver 同步 ACK 后返回 pending Promise，之后失败也不得重发", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "first");
  lib.enqueue("c1", "m2", "second");
  lib.setOnline("c1", true);

  // deliver 在返回 Promise 前同步调用 acknowledge
  mock.hook = (call) => {
    if (call.seq === 1) {
      lib.acknowledge("c1", 1);
    }
  };
  lib.pump(1000);
  assert.equal(mock.calls.length, 2); // 两条消息都已发起首次投递
  mock.hook = null;

  // 让 seq=1 的 Promise 失败：ACK 已生效，失败不得重新激活
  mock.calls[0].reject(new Error("late failure"));
  await flush();

  // 后续任意 pump、断线重连，都不得再次发送 seq=1
  lib.pump(10_000);
  lib.pump(100_000);
  assert.deepEqual(mock.callsFor("c1", 1).length, 1);

  lib.setOnline("c1", false);
  lib.setOnline("c1", true);
  lib.pump(200_000);
  assert.deepEqual(mock.callsFor("c1", 1).length, 1);
  // seq=2 未确认，重连后应补发
  assert.deepEqual(mock.callsFor("c1", 2).length, 2);
  lib.close();
});

// deliver 同步重入其他操作（enqueue / setOnline）时库保持一致
test("deliver 同步重入 enqueue 与上下线切换", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "first");
  lib.setOnline("c1", true);

  mock.hook = () => {
    // 同步重入：新消息入队
    lib.enqueue("c1", "m2", "second");
  };
  lib.pump(1000);
  assert.equal(mock.calls.length, 1);
  mock.hook = null;

  // 重入入队的消息在下一次 pump 发起首次投递
  lib.pump(2000);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].seq, 2);

  // deliver 同步把会话切离线：同一 pump 内后续消息不得再发起
  const mock2 = new DeliverMock();
  const lib2 = new DeliveryLibrary(tmpDbPath(), mock2.fn);
  lib2.enqueue("c2", "m1", "a");
  lib2.enqueue("c2", "m2", "b");
  lib2.setOnline("c2", true);
  mock2.hook = () => {
    lib2.setOnline("c2", false);
  };
  lib2.pump(1000);
  assert.equal(mock2.calls.length, 1); // 离线后不得发起新的 deliver 调用
  lib.close();
  lib2.close();
});
