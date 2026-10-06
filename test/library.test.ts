import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  RecommendationLetterLibrary,
  ContentMismatchError,
  TokenExpiredError,
  UnknownTokenError,
} from "../src/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

class FakeClock {
  now: number;
  constructor(start: number) {
    this.now = start;
  }
  clock = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

function makeLibrary(clock: FakeClock) {
  const dir = mkdtempSync(join(tmpdir(), "letters-"));
  const library = new RecommendationLetterLibrary({
    dbPath: join(dir, "meta.sqlite"),
    filesDir: join(dir, "files"),
    clock: clock.clock,
  });
  return {
    library,
    cleanup: () => {
      library.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function* streamOf(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}


async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function statusOf(
  library: RecommendationLetterLibrary,
  token: string,
): Promise<string> {
  const result = library.read(token);
  if (result.status === "submitted") {
    // 排空流，避免清理临时目录时仍有未完成的文件打开。
    await readAll((result as { stream: NodeJS.ReadableStream }).stream);
  }
  return result.status;
}

test("createToken 返回 14 天后的到期时间", () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    const { token, expiresAt } = library.createToken("app-1");
    assert.equal(typeof token, "string");
    assert.equal(expiresAt, 1_000_000 + 14 * DAY_MS);
    assert.deepEqual(library.read(token), { status: "pending" });
  } finally {
    cleanup();
  }
});

test("场景1: 提交后超过有效期，相同内容重试成功、不同内容拒绝、原信件逐字节不变", async () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    const { token } = library.createToken("app-1");
    const letter = [bytes("%PDF-1.4 head "), bytes("body "), bytes("tail")];
    await library.submit(token, streamOf(letter));

    // 超过有效期。
    clock.advance(30 * DAY_MS);

    // 已提交的 token 不变成 expired，且仍能读到原始信件。
    const result = library.read(token);
    assert.equal(result.status, "submitted");
    const original = await readAll(
      (result as { stream: NodeJS.ReadableStream }).stream,
    );
    assert.deepEqual(original, Buffer.concat(letter.map((c) => Buffer.from(c))));

    // 逐字节相同的内容重试成功，即使已超过原有效期。
    await library.submit(token, streamOf(letter));

    // 不同内容被拒绝。
    await assert.rejects(
      library.submit(token, streamOf([bytes("%PDF-1.4 tampered")])),
      ContentMismatchError,
    );

    // 原信件逐字节不变。
    const after = library.read(token);
    assert.equal(after.status, "submitted");
    const reread = await readAll(
      (after as { stream: NodeJS.ReadableStream }).stream,
    );
    assert.deepEqual(reread, original);
  } finally {
    cleanup();
  }
});

test("有效期在完整接收输入之后判定：上传中途过期则拒绝", async () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    const { token } = library.createToken("app-1");
    const self = clock;
    async function* slowSource(): AsyncIterable<Uint8Array> {
      yield bytes("chunk-1 ");
      self.advance(15 * DAY_MS); // 接收期间越过有效期
      yield bytes("chunk-2");
    }
    await assert.rejects(
      library.submit(token, slowSource()),
      TokenExpiredError,
    );
    assert.deepEqual(library.read(token), { status: "expired" });
  } finally {
    cleanup();
  }
});

test("判定时间必须严格早于到期时间：等于到期时间即拒绝", async () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    const { token, expiresAt } = library.createToken("app-1");
    clock.now = expiresAt;
    await assert.rejects(
      library.submit(token, streamOf([bytes("data")])),
      TokenExpiredError,
    );
    clock.now = expiresAt - 1;
    await library.submit(token, streamOf([bytes("data")]));
    assert.equal(await statusOf(library, token), "submitted");
  } finally {
    cleanup();
  }
});

test("读取输入流中途失败不留下已提交状态，token 仍可再次使用", async () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    const { token } = library.createToken("app-1");
    async function* failing(): AsyncIterable<Uint8Array> {
      yield bytes("partial ");
      throw new Error("upload interrupted");
    }
    await assert.rejects(library.submit(token, failing()), /upload interrupted/);
    assert.deepEqual(library.read(token), { status: "pending" });

    // 未提交尝试不消耗 token：随后可以正常提交。
    await library.submit(token, streamOf([bytes("real letter")]));
    const result = library.read(token);
    assert.equal(result.status, "submitted");
    const content = await readAll(
      (result as { stream: NodeJS.ReadableStream }).stream,
    );
    assert.deepEqual(content, Buffer.from("real letter"));
  } finally {
    cleanup();
  }
});

test("pending 超时后 read 返回 expired；submitted 不随时间变 expired", async () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    const pending = library.createToken("app-pending");
    const submitted = library.createToken("app-submitted");
    await library.submit(submitted.token, streamOf([bytes("letter")]));

    clock.advance(20 * DAY_MS);

    assert.deepEqual(library.read(pending.token), { status: "expired" });
    assert.equal(await statusOf(library, submitted.token), "submitted");
  } finally {
    cleanup();
  }
});

test("未知 token 抛出 UnknownTokenError", async () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    assert.throws(() => library.read("nope"), UnknownTokenError);
    await assert.rejects(
      library.submit("nope", streamOf([bytes("x")])),
      UnknownTokenError,
    );
  } finally {
    cleanup();
  }
});

test("read 返回的流可逐字节还原原始信件（含二进制字节）", async () => {
  const clock = new FakeClock(1_000_000);
  const { library, cleanup } = makeLibrary(clock);
  try {
    const { token } = library.createToken("app-1");
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) % 256;
    await library.submit(token, streamOf([binary.subarray(0, 1000), binary.subarray(1000)]));
    const result = library.read(token);
    assert.equal(result.status, "submitted");
    const stream = (result as { stream: NodeJS.ReadableStream }).stream;
    assert.ok(stream instanceof Readable);
    assert.deepEqual(await readAll(stream), Buffer.from(binary));
  } finally {
    cleanup();
  }
});
