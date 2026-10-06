import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DeliveryLibrary } from "../src/index";
import { DeliverMock, flush, tmpDbPath } from "./helpers";

// 必测场景 2：两次 pump 重叠，投递尚未结束时断线再重连；
// 让旧调用在新一轮投递之后才完成，验证没有重复占额、额外重试或到期时间污染。
test("重叠 pump + 重连 + 旧调用迟到完成", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.enqueue("c1", "m2", "b");
  lib.setOnline("c1", true);

  // deliver 同步重入 pump：构造两次 pump 重叠
  let reentered = false;
  mock.hook = () => {
    if (!reentered) {
      reentered = true;
      lib.pump(1000); // 内层 pump 不得重复发起任何消息
    }
  };
  lib.pump(1000);
  mock.hook = null;
  assert.equal(mock.calls.length, 2, "重叠 pump 不得重复发起");
  assert.equal(mock.callsFor("c1", 1).length, 1);
  assert.equal(mock.callsFor("c1", 2).length, 1);

  // 投递尚未结束时断线再重连
  lib.setOnline("c1", false);
  lib.setOnline("c1", true);

  // 新一轮投递（新额度）
  lib.pump(2000);
  assert.equal(mock.callsFor("c1", 1).length, 2);
  assert.equal(mock.callsFor("c1", 2).length, 2);

  // 旧调用（断线前发起）在新一轮投递之后才失败：不得占额、不得排定重试
  mock.calls[0].reject(new Error("stale failure"));
  mock.calls[1].reject(new Error("stale failure"));
  await flush();
  lib.pump(2_000 + 5_000); // 若被污染，此处会出现基于旧发起的重试
  lib.pump(100_000);
  assert.equal(mock.calls.length, 4, "旧调用迟到失败不得产生额外重试");

  // 新一轮调用失败：正常按本轮发起时间排定重试（2000 + 5000）
  mock.calls[2].reject(new Error("fresh failure"));
  await flush();
  lib.pump(6_999);
  assert.equal(mock.callsFor("c1", 1).length, 2, "到期时间须按本轮发起计算");
  lib.pump(7_000);
  assert.equal(mock.callsFor("c1", 1).length, 3, "本轮失败的重试应按时发生");
  lib.close();
});

// 旧调用迟到成功同样不得改变本轮状态
test("旧调用迟到成功不影响本轮投递", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  lib.pump(1000);
  assert.equal(mock.calls.length, 1);

  lib.setOnline("c1", false);
  lib.setOnline("c1", true);
  lib.pump(2000);
  assert.equal(mock.calls.length, 2);

  mock.calls[0].resolve(); // 上一在线期间的调用迟到成功
  await flush();
  // deliver 完成不代表确认：消息未 ACK，本轮调用仍在进行；
  // 本轮若失败，仍按本轮规则重试
  mock.calls[1].reject(new Error("boom"));
  await flush();
  lib.pump(7_000);
  assert.equal(mock.calls.length, 3);
  lib.close();
});
