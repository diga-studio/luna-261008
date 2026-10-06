import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  Vault,
  VaultConflictError,
  VaultIntegrityError,
  VaultSealedError,
} from "../src/index";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vaultterm-test-"));
}

function makeKey(seed: number): Buffer {
  return Buffer.alloc(32, seed);
}

const SESSION = "session-alpha";

function readLogLines(dir: string): string[] {
  const content = fs.readFileSync(path.join(dir, "vault.log"), "utf8");
  return content.length === 0 ? [] : content.trimEnd().split("\n");
}

function writeLogLines(dir: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "vault.log"), lines.map((l) => l + "\n").join(""));
}

test("append 返回从 1 开始的连续序号，重开后序号接续", () => {
  const dir = makeDir();
  const key = makeKey(1);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  assert.equal(vault.append("e1", Buffer.from("a")), 1);
  assert.equal(vault.append("e2", Buffer.from("b")), 2);
  assert.equal(vault.append("e3", Buffer.from("c")), 3);

  const reopened = Vault.open({ dir, key, sessionId: SESSION });
  assert.equal(reopened.append("e4", Buffer.from("d")), 4);
  const result = reopened.read();
  assert.deepEqual(
    result.records.map((r) => [r.seq, r.eventId, r.bytes.toString()]),
    [
      [1, "e1", "a"],
      [2, "e2", "b"],
      [3, "e3", "c"],
      [4, "e4", "d"],
    ],
  );
  assert.equal(result.sealed, false);
});

test("相同 eventId 与字节重试返回原序号，不同字节报冲突，重开后去重历史保留", () => {
  const dir = makeDir();
  const key = makeKey(2);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  assert.equal(vault.append("e1", Buffer.from("keystroke-1")), 1);
  assert.equal(vault.append("e1", Buffer.from("keystroke-1")), 1);
  assert.throws(
    () => vault.append("e1", Buffer.from("keystroke-2")),
    VaultConflictError,
  );

  const reopened = Vault.open({ dir, key, sessionId: SESSION });
  assert.equal(reopened.append("e1", Buffer.from("keystroke-1")), 1);
  assert.throws(
    () => reopened.append("e1", Buffer.from("keystroke-3")),
    VaultConflictError,
  );
  assert.equal(reopened.append("e2", Buffer.from("keystroke-9")), 2);
});

test("封存后重新打开：重复 seal 与已有事件重试放行，新事件被拒绝，封存不可撤销", () => {
  const dir = makeDir();
  const key = makeKey(3);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  assert.equal(vault.append("e1", Buffer.from("x")), 1);
  assert.equal(vault.append("e2", Buffer.from("y")), 2);
  vault.seal();
  vault.seal();

  const reopened = Vault.open({ dir, key, sessionId: SESSION });
  reopened.seal();
  assert.equal(reopened.append("e1", Buffer.from("x")), 1);
  assert.equal(reopened.append("e2", Buffer.from("y")), 2);
  assert.throws(() => reopened.append("e3", Buffer.from("z")), VaultSealedError);
  assert.throws(
    () => reopened.append("e1", Buffer.from("different")),
    VaultConflictError,
  );

  const again = Vault.open({ dir, key, sessionId: SESSION });
  const result = again.read();
  assert.equal(result.sealed, true);
  assert.deepEqual(
    result.records.map((r) => r.eventId),
    ["e1", "e2"],
  );
  assert.throws(() => again.append("e3", Buffer.from("z")), VaultSealedError);
});

test("篡改中间密文字节后重新打开失败", () => {
  const dir = makeDir();
  const key = makeKey(4);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  vault.append("e1", Buffer.from("first"));
  vault.append("e2", Buffer.from("second"));
  vault.append("e3", Buffer.from("third"));

  const lines = readLogLines(dir);
  const record = JSON.parse(lines[1]) as unknown[];
  const ciphertext = Buffer.from(record[4] as string, "base64");
  ciphertext[0] = ciphertext[0]! ^ 0xff;
  record[4] = ciphertext.toString("base64");
  lines[1] = JSON.stringify(record);
  writeLogLines(dir, lines);

  assert.throws(() => Vault.open({ dir, key, sessionId: SESSION }), VaultIntegrityError);
});

test("截掉封存日志末尾后重新打开失败", () => {
  const dir = makeDir();
  const key = makeKey(5);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  vault.append("e1", Buffer.from("first"));
  vault.append("e2", Buffer.from("second"));
  vault.seal();

  const lines = readLogLines(dir);
  assert.equal(lines.length, 3);
  writeLogLines(dir, lines.slice(0, 2));

  assert.throws(() => Vault.open({ dir, key, sessionId: SESSION }), VaultIntegrityError);
});

test("删除中间记录后重新打开失败", () => {
  const dir = makeDir();
  const key = makeKey(6);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  vault.append("e1", Buffer.from("a"));
  vault.append("e2", Buffer.from("b"));
  vault.append("e3", Buffer.from("c"));

  const lines = readLogLines(dir);
  lines.splice(1, 1);
  writeLogLines(dir, lines);

  assert.throws(() => Vault.open({ dir, key, sessionId: SESSION }), VaultIntegrityError);
});

test("交换两条记录顺序后重新打开失败", () => {
  const dir = makeDir();
  const key = makeKey(7);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  vault.append("e1", Buffer.from("a"));
  vault.append("e2", Buffer.from("b"));
  vault.append("e3", Buffer.from("c"));

  const lines = readLogLines(dir);
  [lines[1], lines[2]] = [lines[2]!, lines[1]!];
  writeLogLines(dir, lines);

  assert.throws(() => Vault.open({ dir, key, sessionId: SESSION }), VaultIntegrityError);
});

test("跨会话替换日志后重新打开失败", () => {
  const dirA = makeDir();
  const dirB = makeDir();
  const key = makeKey(8);
  const vaultA = Vault.open({ dir: dirA, key, sessionId: "session-a" });
  vaultA.append("e1", Buffer.from("from-a"));
  const vaultB = Vault.open({ dir: dirB, key, sessionId: "session-b" });
  vaultB.append("e1", Buffer.from("from-b"));

  fs.copyFileSync(path.join(dirB, "vault.log"), path.join(dirA, "vault.log"));
  assert.throws(
    () => Vault.open({ dir: dirA, key, sessionId: "session-a" }),
    VaultIntegrityError,
  );
});

test("错误密钥无法恢复会话", () => {
  const dir = makeDir();
  const vault = Vault.open({ dir, key: makeKey(9), sessionId: SESSION });
  vault.append("e1", Buffer.from("secret"));
  assert.throws(
    () => Vault.open({ dir, key: makeKey(10), sessionId: SESSION }),
    VaultIntegrityError,
  );
});

test("同一密钥下 nonce 不复用", () => {
  const dir = makeDir();
  const key = makeKey(11);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  for (let i = 0; i < 50; i++) {
    vault.append(`e${i}`, Buffer.from(`payload-${i}`));
  }
  const nonces = readLogLines(dir).map(
    (line) => (JSON.parse(line) as unknown[])[3] as string,
  );
  assert.equal(new Set(nonces).size, nonces.length);
});

test("已提交数据缺失（日志或元数据）时拒绝恢复", () => {
  const dir = makeDir();
  const key = makeKey(12);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  vault.append("e1", Buffer.from("a"));

  fs.rmSync(path.join(dir, "vault.meta.json"));
  assert.throws(() => Vault.open({ dir, key, sessionId: SESSION }), VaultIntegrityError);

  const dir2 = makeDir();
  const vault2 = Vault.open({ dir: dir2, key, sessionId: SESSION });
  vault2.append("e1", Buffer.from("a"));
  fs.rmSync(path.join(dir2, "vault.log"));
  assert.throws(() => Vault.open({ dir: dir2, key, sessionId: SESSION }), VaultIntegrityError);
});

test("read 检出打开之后发生的日志篡改", () => {
  const dir = makeDir();
  const key = makeKey(13);
  const vault = Vault.open({ dir, key, sessionId: SESSION });
  vault.append("e1", Buffer.from("a"));
  vault.append("e2", Buffer.from("b"));

  const lines = readLogLines(dir);
  lines.pop();
  writeLogLines(dir, lines);

  assert.throws(() => vault.read(), VaultIntegrityError);
});
