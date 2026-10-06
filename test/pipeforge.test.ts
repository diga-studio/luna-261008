import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PipeForge } from "../src/index";

function sha256Of(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeWorkspace(): { root: string; srcDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeforge-test-"));
  const srcDir = path.join(root, "sources");
  fs.mkdirSync(srcDir, { recursive: true });
  return { root, srcDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeSource(srcDir: string, name: string, content: string): string {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, Buffer.from(content, "utf8"));
  return p;
}

/** 校验 inspect 报告的每个保留版本都能逐字节读回并通过 SHA-256 验证 */
async function assertRetainedVersionsReadable(pf: PipeForge, output: string): Promise<void> {
  const info = await pf.inspect(output);
  for (const v of info.versions) {
    const versionFile = path.join(
      path.dirname(info.currentPath),
      "versions",
      String(v.version),
    );
    const bytes = fs.readFileSync(versionFile);
    assert.equal(bytes.length, v.size, `version ${v.version} size mismatch`);
    assert.equal(sha256Of(bytes), v.sha256, `version ${v.version} sha256 mismatch`);
  }
}

test("retry same requestId: version, current bytes, retained versions and hashes stay consistent", async () => {
  const { root, srcDir, cleanup } = makeWorkspace();
  try {
    const pf = new PipeForge(root);
    const src1 = writeSource(srcDir, "a.txt", "hello-v1");
    const src2 = writeSource(srcDir, "b.txt", "hello-v2");

    const v1 = await pf.publish("report", "req-1", src1);
    assert.equal(v1, 1);
    const v2 = await pf.publish("report", "req-2", src2);
    assert.equal(v2, 2);

    const infoBefore = await pf.inspect("report");
    const currentBefore = fs.readFileSync(infoBefore.currentPath);

    // 换一个实例重试，验证幂等记录已持久化
    const pf2 = new PipeForge(root);
    const retry1 = await pf2.publish("report", "req-1", src1);
    assert.equal(retry1, 1, "retry of req-1 must return original version 1");
    const retry2 = await pf2.publish("report", "req-2", src2);
    assert.equal(retry2, 2, "retry of req-2 must return original version 2");

    const infoAfter = await pf.inspect("report");
    assert.equal(infoAfter.currentVersion, 2, "current version unchanged after retries");
    assert.deepEqual(
      fs.readFileSync(infoAfter.currentPath),
      currentBefore,
      "current delivery bytes unchanged after retries",
    );
    assert.deepEqual(infoAfter.versions, infoBefore.versions, "retained versions unchanged");

    // 当前交付路径是稳定路径上的普通文件，字节与当前版本一致
    const stat = fs.statSync(infoAfter.currentPath);
    assert.ok(stat.isFile(), "current path must be a regular file");
    assert.deepEqual(fs.readFileSync(infoAfter.currentPath), Buffer.from("hello-v2"));

    // 所有保留版本逐字节读回 + SHA-256 验证
    await assertRetainedVersionsReadable(pf, "report");

    // 相同 requestId 但参数不同 -> 报错
    await assert.rejects(() => pf.publish("report", "req-1", src2));
  } finally {
    cleanup();
  }
});

test("publish 20 versions, rollback to v1 as v21, retries stay idempotent after eviction", async () => {
  const { root, srcDir, cleanup } = makeWorkspace();
  try {
    const pf = new PipeForge(root);
    const output = "site-bundle";

    // 发布 20 个版本，记录每个版本内容
    const contents: Buffer[] = [];
    for (let i = 1; i <= 20; i++) {
      const src = writeSource(srcDir, `v${i}.txt`, `content-of-version-${i}`);
      contents.push(Buffer.from(`content-of-version-${i}`, "utf8"));
      const v = await pf.publish(output, `pub-${i}`, src);
      assert.equal(v, i);
    }

    // 从第 1 版回滚，生成第 21 版
    const v21 = await pf.rollback(output, "rb-1", 1);
    assert.equal(v21, 21);

    let info = await pf.inspect(output);
    assert.equal(info.currentVersion, 21);
    assert.deepEqual(
      fs.readFileSync(info.currentPath),
      contents[0],
      "current bytes must equal original version 1",
    );

    // 只保留第 2 至第 21 版
    assert.deepEqual(
      info.versions.map((v) => v.version),
      Array.from({ length: 20 }, (_, i) => i + 2),
      "only versions 2..21 are retained",
    );
    await assertRetainedVersionsReadable(pf, output);

    // 重试回滚请求：即使第 1 版已被淘汰，也必须返回 21，且不产生新版本
    const pf2 = new PipeForge(root);
    const retryRollback = await pf2.rollback(output, "rb-1", 1);
    assert.equal(retryRollback, 21, "retry of rollback must return 21");
    info = await pf.inspect(output);
    assert.equal(info.currentVersion, 21, "no new version appended on rollback retry");
    assert.deepEqual(fs.readFileSync(info.currentPath), contents[0]);
    assert.equal(info.versions.length, 20);

    // 重试第 1 版的 publish 请求：必须返回 1，且不能改变当前版本
    const src1 = path.join(srcDir, "v1.txt");
    const retryPub1 = await pf2.publish(output, "pub-1", src1);
    assert.equal(retryPub1, 1, "retry of evicted publish must return original version 1");
    info = await pf.inspect(output);
    assert.equal(info.currentVersion, 21, "current version unchanged after publish retry");
    assert.deepEqual(
      fs.readFileSync(info.currentPath),
      contents[0],
      "current delivery file unchanged after publish retry",
    );
    assert.deepEqual(
      info.versions.map((v) => v.version),
      Array.from({ length: 20 }, (_, i) => i + 2),
      "retained set still 2..21",
    );
    await assertRetainedVersionsReadable(pf, output);

    // 回滚到已被淘汰的版本（新 requestId）-> 报错
    await assert.rejects(() => pf.rollback(output, "rb-2", 1));
  } finally {
    cleanup();
  }
});
