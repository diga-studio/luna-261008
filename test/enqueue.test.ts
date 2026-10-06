import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DeliveryLibrary } from "../src/index";
import { DeliverMock, flush, tmpDbPath } from "./helpers";

test("enqueue 返回会话内从 1 开始连续递增的 seq，各会话独立", () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  assert.equal(lib.enqueue("c1", "m1", "hello"), 1);
  assert.equal(lib.enqueue("c1", "m2", "world"), 2);
  assert.equal(lib.enqueue("c2", "m9", "other"), 1);
  assert.equal(lib.enqueue("c1", "m3", "again"), 3);
  lib.close();
});

test("相同 messageId 与文本重复提交返回原 seq，不新增消息", () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  assert.equal(lib.enqueue("c1", "m1", "hello"), 1);
  assert.equal(lib.enqueue("c1", "m1", "hello"), 1);
  assert.equal(lib.enqueue("c1", "m2", "next"), 2);
  lib.close();
});

test("相同 messageId 换文本必须拒绝", () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "hello");
  assert.throws(() => lib.enqueue("c1", "m1", "changed"), /different text/);
  // 拒绝不占用 seq
  assert.equal(lib.enqueue("c1", "m2", "next"), 2);
  lib.close();
});

test("离线时 pump 不发起任何 deliver 调用", () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "hello");
  lib.pump(1000);
  assert.equal(mock.calls.length, 0);
  lib.close();
});

test("在线后 pump 按 seq 递增发起首次投递", () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.enqueue("c1", "m2", "b");
  lib.enqueue("c1", "m3", "c");
  lib.setOnline("c1", true);
  lib.pump(1000);
  assert.deepEqual(mock.calls.map((c) => c.seq), [1, 2, 3]);
  lib.close();
});

test("deliver 完成不代表确认；成功投递后未 ACK 不重试但保留", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  lib.pump(1000);
  assert.equal(mock.calls.length, 1);
  mock.calls[0].resolve();
  await flush();
  // 成功投递未确认：本在线期间不再主动重试
  lib.pump(2000);
  lib.pump(100_000);
  assert.equal(mock.calls.length, 1);
  lib.close();
});

test("重复 acknowledge 与迟到 ACK 无害", async () => {
  const mock = new DeliverMock();
  const lib = new DeliveryLibrary(tmpDbPath(), mock.fn);

  lib.enqueue("c1", "m1", "a");
  lib.setOnline("c1", true);
  lib.pump(1000);
  lib.acknowledge("c1", 1);
  lib.acknowledge("c1", 1);
  lib.acknowledge("c1", 999); // 不存在的 seq
  // 断线后迟到的 ACK（针对断线前投递的消息）同样无害
  lib.setOnline("c1", false);
  lib.acknowledge("c1", 1);
  lib.setOnline("c1", true);
  lib.pump(200_000);
  assert.equal(mock.calls.length, 1); // 已确认消息不再补发
  lib.close();
});
