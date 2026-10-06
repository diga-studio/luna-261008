import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DeliveryLibrary } from "../src/index";
import { DeliverMock, flush, tmpDbPath } from "./helpers";

// 必测场景 3：离线期间重复提交消息，在线后耗尽部分消息的额度并确认另一部分；
// 重新打开库再上线，验证只补发未确认消息，首次补发按原 seq 排序，且原 messageId 仍返回原 seq。
test("重开库后只补发未确认消息，顺序与 seq 保持", async () => {
  const dbPath = tmpDbPath();
  const mock1 = new DeliverMock();
  const lib1 = new DeliveryLibrary(dbPath, mock1.fn);

  // 离线期间重复提交：相同 messageId+文本返回原 seq，不新增
  assert.equal(lib1.enqueue("c1", "m1", "one"), 1);
  assert.equal(lib1.enqueue("c1", "m1", "one"), 1);
  assert.equal(lib1.enqueue("c1", "m2", "two"), 2);
  assert.equal(lib1.enqueue("c1", "m2", "two"), 2);
  assert.equal(lib1.enqueue("c1", "m3", "three"), 3);
  assert.equal(lib1.enqueue("c1", "m4", "four"), 4);
  // 离线时 pump 不投递
  lib1.pump(0);
  assert.equal(mock1.calls.length, 0);

  lib1.setOnline("c1", true);
  // 耗尽 m2（seq=2）的额度：首次 + 3 次重试全部失败
  for (let round = 0; round < 4; round++) {
    lib1.pump(round * 5000);
    for (const call of mock1.calls.splice(0)) {
      if (call.seq === 1) {
        call.resolve(); // m1 投递成功
      } else if (call.seq === 2) {
        call.reject(new Error("boom")); // m2 持续失败
      } else {
        call.resolve(); // m3、m4 先成功
      }
    }
    await flush();
  }
  // 确认 m1 与 m3；m2 额度耗尽未确认；m4 成功但未确认
  lib1.acknowledge("c1", 1);
  lib1.acknowledge("c1", 3);
  lib1.close();

  // 重新打开：新实例从离线开始
  const mock2 = new DeliverMock();
  const lib2 = new DeliveryLibrary(dbPath, mock2.fn);
  lib2.pump(1_000_000);
  assert.equal(mock2.calls.length, 0, "重开后默认离线，不得投递");

  // 原 messageId 仍返回原 seq
  assert.equal(lib2.enqueue("c1", "m1", "one"), 1);
  assert.equal(lib2.enqueue("c1", "m2", "two"), 2);
  assert.equal(lib2.enqueue("c1", "m3", "three"), 3);
  assert.equal(lib2.enqueue("c1", "m4", "four"), 4);
  assert.equal(lib2.enqueue("c1", "m5", "five"), 5, "seq 继续递增");
  assert.throws(() => lib2.enqueue("c1", "m2", "changed"), /different text/);

  // 上线补发：只有未确认的 m2、m4、m5，按原 seq 排序
  lib2.setOnline("c1", true);
  lib2.pump(2_000_000);
  assert.deepEqual(
    mock2.calls.map((c) => c.seq),
    [2, 4, 5]
  );
  assert.deepEqual(
    mock2.calls.map((c) => c.text),
    ["two", "four", "five"]
  );
  lib2.close();
});

test("确认结果跨重开持久化", async () => {
  const dbPath = tmpDbPath();
  const mock1 = new DeliverMock();
  const lib1 = new DeliveryLibrary(dbPath, mock1.fn);

  lib1.enqueue("c1", "m1", "a");
  lib1.enqueue("c1", "m2", "b");
  lib1.setOnline("c1", true);
  lib1.pump(0);
  lib1.acknowledge("c1", 2); // 只确认第二条（非累计确认）
  lib1.close();

  const mock2 = new DeliverMock();
  const lib2 = new DeliveryLibrary(dbPath, mock2.fn);
  lib2.setOnline("c1", true);
  lib2.pump(1000);
  assert.deepEqual(
    mock2.calls.map((c) => c.seq),
    [1],
    "只有未确认的 seq=1 补发"
  );
  lib2.close();
});
