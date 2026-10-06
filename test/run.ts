import * as assert from "assert";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Controller } from "../src/controller";
import { Endpoint } from "../src/endpoint";
import type { EndpointCommand, EndpointId, EndpointState } from "../src/types";

const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "key-rotation-"));
}

function snap(dir: string, id: string, ep: EndpointId): EndpointState {
  return new Endpoint(dir, id, ep).snapshot();
}

function exec(dir: string, id: string, ep: EndpointId, cmd: EndpointCommand) {
  return new Endpoint(dir, id, ep).execute(cmd);
}

function newKey(): string {
  return randomBytes(32).toString("hex");
}

// 场景 1a：仅一端安装新接收密钥后，双向通信仍然成立。
test("仅 A 端安装新密钥后双向通信成立", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  const k1 = newKey();
  const r = exec(dir, "t1", "A", {
    kind: "installReceiveKey",
    commandId: "m:install:A",
    key: k1,
  });
  assert.strictEqual(r.applied, true);
  assert.strictEqual(ctl.inspect("t1"), true);
});

test("仅 B 端安装新密钥后双向通信成立", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  const k1 = newKey();
  exec(dir, "t1", "B", {
    kind: "installReceiveKey",
    commandId: "m:install:B",
    key: k1,
  });
  assert.strictEqual(ctl.inspect("t1"), true);
});

// 场景 1b：双端安装后，仅一端切换发送密钥，双向通信仍然成立。
test("仅 A 端切换发送密钥后双向通信成立", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  const k1 = newKey();
  for (const ep of ["A", "B"] as EndpointId[]) {
    exec(dir, "t1", ep, {
      kind: "installReceiveKey",
      commandId: `m:install:${ep}`,
      key: k1,
    });
  }
  exec(dir, "t1", "A", {
    kind: "switchSendKey",
    commandId: "m:switch:A",
    key: k1,
  });
  assert.strictEqual(snap(dir, "t1", "A").sendKey, k1);
  assert.strictEqual(ctl.inspect("t1"), true);
});

test("仅 B 端切换发送密钥后双向通信成立", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  const k1 = newKey();
  for (const ep of ["A", "B"] as EndpointId[]) {
    exec(dir, "t1", ep, {
      kind: "installReceiveKey",
      commandId: `m:install:${ep}`,
      key: k1,
    });
  }
  exec(dir, "t1", "B", {
    kind: "switchSendKey",
    commandId: "m:switch:B",
    key: k1,
  });
  assert.strictEqual(snap(dir, "t1", "B").sendKey, k1);
  assert.strictEqual(ctl.inspect("t1"), true);
});

// 场景 1c：完整轮换后双方发送密钥相同，且只接受新密钥。
test("轮换完成后双方只接受新密钥", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  const k0 = snap(dir, "t1", "A").sendKey;
  ctl.rotate("t1", "r1");
  const a = snap(dir, "t1", "A");
  const b = snap(dir, "t1", "B");
  assert.strictEqual(a.sendKey, b.sendKey);
  assert.notStrictEqual(a.sendKey, k0);
  assert.deepStrictEqual(a.receiveKeys, [a.sendKey]);
  assert.deepStrictEqual(b.receiveKeys, [b.sendKey]);
  assert.strictEqual(ctl.inspect("t1"), true);
});

// 相同 requestId 重放：复用同一代及同一份密钥材料，完成后重放为空操作。
test("相同 requestId 重放不重新应用", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  ctl.rotate("t1", "r1");
  const before = { a: snap(dir, "t1", "A"), b: snap(dir, "t1", "B") };
  ctl.rotate("t1", "r1");
  assert.deepStrictEqual(snap(dir, "t1", "A"), before.a);
  assert.deepStrictEqual(snap(dir, "t1", "B"), before.b);
  // 后续轮换完成后再次重放旧 requestId，也不得重新应用旧密钥。
  ctl.rotate("t1", "r2");
  ctl.rotate("t1", "r1");
  const a = snap(dir, "t1", "A");
  assert.strictEqual(a.sendKey, snap(dir, "t1", "B").sendKey);
  assert.deepStrictEqual(a.receiveKeys, [a.sendKey]);
  assert.strictEqual(ctl.inspect("t1"), true);
});

// 崩溃恢复：轮换中途持久化的 requestId 恢复后复用同一份密钥材料。
test("轮换中断恢复后复用同一密钥材料", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  ctl.rotate("t1", "r1");
  const k1 = snap(dir, "t1", "A").sendKey;
  // 模拟崩溃：把控制器状态回滚到中间阶段（端点已应用的命令不变）。
  const stateFile = path.join(dir, "tunnel-t1-controller.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.rotations[0].stage = "installed";
  fs.writeFileSync(stateFile, JSON.stringify(state));
  new Controller(dir).rotate("t1", "r1");
  const a = snap(dir, "t1", "A");
  assert.strictEqual(a.sendKey, k1);
  assert.deepStrictEqual(a.receiveKeys, [k1]);
  assert.strictEqual(ctl.inspect("t1"), true);
});

// 场景 2：连续两轮轮换后，乱序重放第一轮命令，不影响当前通信、不复活历史密钥。
test("乱序重放历史命令不影响当前状态", () => {
  const dir = freshDir();
  const ctl = new Controller(dir);
  ctl.createTunnel("t1");
  const k0 = snap(dir, "t1", "A").sendKey;
  ctl.rotate("t1", "r1");
  const k1 = snap(dir, "t1", "A").sendKey;
  ctl.rotate("t1", "r2");
  const k2 = snap(dir, "t1", "A").sendKey;
  assert.notStrictEqual(k0, k1);
  assert.notStrictEqual(k1, k2);

  // 重建第一轮的全部命令并乱序（此处逆序交错）重放。
  const round1: Array<[EndpointId, EndpointCommand]> = [];
  for (const ep of ["A", "B"] as EndpointId[]) {
    round1.push([ep, { kind: "installReceiveKey", commandId: `r1:install:${ep}`, key: k1 }]);
    round1.push([ep, { kind: "switchSendKey", commandId: `r1:switch:${ep}`, key: k1 }]);
    round1.push([ep, { kind: "removeReceiveKey", commandId: `r1:remove:${ep}:${k0}`, key: k0 }]);
  }
  const shuffled = [round1[4], round1[1], round1[5], round1[0], round1[3], round1[2]];
  for (const [ep, cmd] of shuffled) {
    const receipt = exec(dir, "t1", ep, cmd);
    assert.strictEqual(receipt.applied, false, `重放 ${cmd.commandId} 不应生效`);
  }

  const a = snap(dir, "t1", "A");
  const b = snap(dir, "t1", "B");
  assert.strictEqual(a.sendKey, k2);
  assert.strictEqual(b.sendKey, k2);
  assert.deepStrictEqual(a.receiveKeys, [k2]);
  assert.deepStrictEqual(b.receiveKeys, [k2]);
  assert.ok(!a.receiveKeys.includes(k0) && !a.receiveKeys.includes(k1));
  assert.ok(!b.receiveKeys.includes(k0) && !b.receiveKeys.includes(k1));
  assert.strictEqual(ctl.inspect("t1"), true);
});

// 持久化：全新控制器/端点实例从磁盘恢复状态。
test("状态可跨实例从磁盘恢复", () => {
  const dir = freshDir();
  new Controller(dir).createTunnel("t1");
  new Controller(dir).rotate("t1", "r1");
  const k1 = snap(dir, "t1", "A").sendKey;
  const ctl2 = new Controller(dir);
  assert.strictEqual(ctl2.inspect("t1"), true);
  assert.strictEqual(snap(dir, "t1", "B").sendKey, k1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log(`${tests.length} tests passed`);
