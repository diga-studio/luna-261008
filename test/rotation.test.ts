import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { KeyRotationService } from "../src/tunnel.js";
import type { KeyMaterial } from "../src/types.js";

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "keyrot-"));
}

function cmd(tunnelId: string, req: string, step: string, ep: string): string {
  return `${tunnelId}:${req}:${step}:${ep}`;
}

function newKey(generation: number): KeyMaterial {
  return { generation, key: randomBytes(32).toString("base64") };
}

test("createTunnel 初始化一代 32 字节随机密钥，双向可通信", () => {
  const svc = new KeyRotationService(freshDir());
  svc.createTunnel("t0");
  const a = svc.endpointA("t0");
  const b = svc.endpointB("t0");

  const sendA = a.currentSendKey();
  const sendB = b.currentSendKey();
  assert.ok(sendA);
  assert.ok(sendB);
  assert.equal(sendA.generation, 1);
  assert.equal(sendA.key, sendB.key);
  assert.equal(Buffer.from(sendA.key, "base64").length, 32);
  assert.deepEqual(a.recvGenerations(), [1]);
  assert.deepEqual(b.recvGenerations(), [1]);

  const result = svc.inspect("t0");
  assert.equal(result.ok, true);
  assert.equal(result.aToB, true);
  assert.equal(result.bToA, true);
});

test("轮换中间状态：仅一端安装/切换后双向通信仍成立，完成后只接受新密钥", () => {
  const svc = new KeyRotationService(freshDir());
  svc.createTunnel("t1");
  const a = svc.endpointA("t1");
  const b = svc.endpointB("t1");
  const key1 = a.currentSendKey()!;
  const key2 = newKey(2);

  // 仅 A 安装新接收密钥
  a.installRecvKey(cmd("t1", "r1", "install", "A"), key2);
  assert.equal(svc.inspect("t1").ok, true, "仅 A 安装后通信应成立");

  // 仅 B 安装新接收密钥
  b.installRecvKey(cmd("t1", "r1", "install", "B"), key2);
  assert.equal(svc.inspect("t1").ok, true, "仅 B 安装后通信应成立");

  // 仅 A 切换发送密钥
  a.switchSendKey(cmd("t1", "r1", "switch", "A"), key2);
  assert.equal(svc.inspect("t1").ok, true, "仅 A 切换发送后通信应成立");

  // 仅 B 切换发送密钥
  b.switchSendKey(cmd("t1", "r1", "switch", "B"), key2);
  assert.equal(svc.inspect("t1").ok, true, "仅 B 切换发送后通信应成立");

  // 移除旧接收密钥
  a.removeRecvKey(cmd("t1", "r1", "remove", "A"), 1);
  b.removeRecvKey(cmd("t1", "r1", "remove", "B"), 1);
  assert.equal(svc.inspect("t1").ok, true, "移除旧密钥后通信应成立");

  // 完成后：双方发送密钥相同，且只接受新密钥
  assert.deepEqual(a.currentSendKey(), key2);
  assert.deepEqual(b.currentSendKey(), key2);
  assert.deepEqual(a.recvGenerations(), [2]);
  assert.deepEqual(b.recvGenerations(), [2]);
  assert.equal(a.accepts(key1), false, "A 不应再接受旧密钥");
  assert.equal(b.accepts(key1), false, "B 不应再接受旧密钥");
  assert.equal(a.accepts(key2), true);
  assert.equal(b.accepts(key2), true);
});

test("两轮轮换后乱序重放第一轮命令：通信不受影响，历史密钥不复活", () => {
  const svc = new KeyRotationService(freshDir());
  svc.createTunnel("t2");
  svc.rotate("t2", "r1"); // 进入第 2 代
  svc.rotate("t2", "r2"); // 进入第 3 代

  const state = svc.controller.tunnelState("t2");
  assert.equal(state.generation, 3);
  const key1: KeyMaterial = { generation: 1, key: state.keys["1"] };
  const key2: KeyMaterial = { generation: 2, key: state.keys["2"] };
  const key3: KeyMaterial = { generation: 3, key: state.keys["3"] };

  const a = svc.endpointA("t2");
  const b = svc.endpointB("t2");

  // 乱序重放第一轮的安装、切换、移除命令
  const receipts = [
    b.removeRecvKey(cmd("t2", "r1", "remove", "B"), 1),
    a.switchSendKey(cmd("t2", "r1", "switch", "A"), key2),
    b.installRecvKey(cmd("t2", "r1", "install", "B"), key2),
    a.removeRecvKey(cmd("t2", "r1", "remove", "A"), 1),
    b.switchSendKey(cmd("t2", "r1", "switch", "B"), key2),
    a.installRecvKey(cmd("t2", "r1", "install", "A"), key2),
  ];
  for (const r of receipts) {
    assert.equal(r.replayed, true, `命令 ${r.commandId} 应命中幂等去重`);
  }

  // 当前双向通信不受影响
  assert.equal(svc.inspect("t2").ok, true);

  // 发送密钥未回退，双方一致
  assert.deepEqual(a.currentSendKey(), key3);
  assert.deepEqual(b.currentSendKey(), key3);

  // 历史密钥没有重新进入可用集合
  assert.deepEqual(a.recvGenerations(), [3]);
  assert.deepEqual(b.recvGenerations(), [3]);
  assert.equal(a.accepts(key1), false);
  assert.equal(a.accepts(key2), false);
  assert.equal(b.accepts(key1), false);
  assert.equal(b.accepts(key2), false);
  assert.equal(a.accepts(key3), true);
  assert.equal(b.accepts(key3), true);
});

test("相同 requestId 复用同一代同一密钥材料，完成后重放不再应用", () => {
  const svc = new KeyRotationService(freshDir());
  svc.createTunnel("t3");
  svc.rotate("t3", "r1");
  const after1 = svc.controller.tunnelState("t3");
  assert.equal(after1.generation, 2);

  // 同一 requestId 重复提交：代数与密钥材料不变
  svc.rotate("t3", "r1");
  const again = svc.controller.tunnelState("t3");
  assert.equal(again.generation, 2);
  assert.equal(again.key, after1.key);

  // 新一轮后再重放旧 requestId：不得重新应用旧密钥
  svc.rotate("t3", "r2");
  svc.rotate("t3", "r1");
  const final = svc.controller.tunnelState("t3");
  assert.equal(final.generation, 3);

  const a = svc.endpointA("t3");
  const b = svc.endpointB("t3");
  assert.equal(a.currentSendKey()!.generation, 3);
  assert.equal(b.currentSendKey()!.generation, 3);
  assert.deepEqual(a.recvGenerations(), [3]);
  assert.deepEqual(b.recvGenerations(), [3]);
  assert.equal(svc.inspect("t3").ok, true);
});

test("伪造旧命令（新 commandId + 旧代密钥）不能使发送密钥回退或复活旧密钥", () => {
  const svc = new KeyRotationService(freshDir());
  svc.createTunnel("t4");
  svc.rotate("t4", "r1");
  const state = svc.controller.tunnelState("t4");
  const key1: KeyMaterial = { generation: 1, key: state.keys["1"] };

  const a = svc.endpointA("t4");
  // 用从未见过的 commandId 携带旧代密钥直接打到端点
  const r1 = a.switchSendKey("t4:evil:switch:A", key1);
  assert.equal(r1.applied, false);
  const r2 = a.installRecvKey("t4:evil:install:A", key1);
  assert.equal(r2.applied, false);

  assert.equal(a.currentSendKey()!.generation, 2);
  assert.deepEqual(a.recvGenerations(), [2]);
  assert.equal(svc.inspect("t4").ok, true);
});

test("状态持久化：新实例加载同一存储目录后状态完整", () => {
  const dir = freshDir();
  const svc1 = new KeyRotationService(dir);
  svc1.createTunnel("t5");
  svc1.rotate("t5", "r1");

  // 模拟进程重启：全新实例读取同一目录
  const svc2 = new KeyRotationService(dir);
  assert.equal(svc2.inspect("t5").ok, true);
  const a = svc2.endpointA("t5");
  const b = svc2.endpointB("t5");
  assert.equal(a.currentSendKey()!.generation, 2);
  assert.equal(b.currentSendKey()!.generation, 2);
  assert.deepEqual(a.recvGenerations(), [2]);
  assert.deepEqual(b.recvGenerations(), [2]);

  // 重启后继续轮换正常推进
  svc2.rotate("t5", "r2");
  assert.equal(svc2.inspect("t5").ok, true);
  assert.equal(svc2.endpointA("t5").currentSendKey()!.generation, 3);
});
