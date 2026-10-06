import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LetterVault, TOKEN_TTL_MS, VaultError } from "../src/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    clock: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function* bytesOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) parts.push(chunk);
  return Buffer.concat(parts);
}

async function withVault(
  fn: (vault: LetterVault, clock: ReturnType<typeof makeClock>) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "vault-test-"));
  const clock = makeClock();
  const vault = new LetterVault({
    dbPath: ":memory:",
    storageDir: dir,
    clock: clock.clock,
  });
  try {
    await fn(vault, clock);
  } finally {
    vault.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("createToken returns token and expiry 14 days out; read is pending", async () => {
  await withVault(async (vault, clock) => {
    const before = clock.clock();
    const { token, expiresAt } = await vault.createToken("app-1");
    assert.ok(token.length > 0);
    assert.equal(expiresAt, before + TOKEN_TTL_MS);
    assert.equal(expiresAt - before, 14 * DAY_MS);
    const result = await vault.read(token);
    assert.equal(result.status, "pending");
    assert.equal(result.stream, undefined);
  });
});

test("submit stores the letter; read returns identical bytes", async () => {
  await withVault(async (vault) => {
    const { token } = await vault.createToken("app-1");
    const content = new TextEncoder().encode("%PDF-fake letter contents");
    const result = await vault.submit(token, bytesOf(content));
    assert.deepEqual(result, { ok: true, stored: true });
    const read = await vault.read(token);
    assert.equal(read.status, "submitted");
    assert.ok(read.stream);
    const got = await streamToBuffer(read.stream);
    assert.deepEqual(got, Buffer.from(content));
  });
});

test("after expiry: identical retry succeeds, different content rejected, letter unchanged", async () => {
  await withVault(async (vault, clock) => {
    const { token } = await vault.createToken("app-1");
    const content = Buffer.concat([
      Buffer.from("%PDF-1.7 letter head "),
      Buffer.from([0, 1, 2, 3, 255, 254]),
      Buffer.from(" letter tail"),
    ]);
    await vault.submit(
      token,
      bytesOf(content.subarray(0, 10), content.subarray(10)),
    );

    // Well past the 14-day expiry.
    clock.advance(30 * DAY_MS);

    // Byte-identical retry succeeds even though the token expired.
    const retry = await vault.submit(token, bytesOf(content));
    assert.deepEqual(retry, { ok: true, stored: false });

    // Different content is rejected.
    const other = new TextEncoder().encode("%PDF-different letter");
    await assert.rejects(
      vault.submit(token, bytesOf(other)),
      (err: unknown) => err instanceof VaultError && err.code === "content_mismatch",
    );

    // Status is still submitted (never flips to expired) and bytes are intact.
    const read = await vault.read(token);
    assert.equal(read.status, "submitted");
    assert.ok(read.stream);
    const got = await streamToBuffer(read.stream);
    assert.deepEqual(got, content);
  });
});

test("expiry is judged after full receipt, not at upload start", async () => {
  await withVault(async (vault, clock) => {
    const { token, expiresAt } = await vault.createToken("app-1");
    const content = new TextEncoder().encode("slow upload");

    async function* slowSource(): AsyncIterable<Uint8Array> {
      yield content.subarray(0, 4);
      // Clock crosses the expiry boundary mid-stream.
      clock.advance(expiresAt - clock.clock());
      yield content.subarray(4);
    }

    await assert.rejects(
      vault.submit(token, slowSource()),
      (err: unknown) => err instanceof VaultError && err.code === "token_expired",
    );
    const read = await vault.read(token);
    assert.equal(read.status, "expired");
  });
});

test("submission exactly at expiry instant is rejected (strict comparison)", async () => {
  await withVault(async (vault, clock) => {
    const { token, expiresAt } = await vault.createToken("app-1");
    clock.advance(expiresAt - clock.clock()); // now === expiresAt
    await assert.rejects(
      vault.submit(token, bytesOf(new TextEncoder().encode("x"))),
      (err: unknown) => err instanceof VaultError && err.code === "token_expired",
    );
  });
});

test("mid-stream failure leaves token pending and unconsumed", async () => {
  await withVault(async (vault) => {
    const { token } = await vault.createToken("app-1");

    async function* failingSource(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("partial");
      throw new Error("network reset");
    }

    await assert.rejects(vault.submit(token, failingSource()), /network reset/);
    const read = await vault.read(token);
    assert.equal(read.status, "pending");

    // Token is still usable after the failed attempt.
    const content = new TextEncoder().encode("real letter");
    const result = await vault.submit(token, bytesOf(content));
    assert.deepEqual(result, { ok: true, stored: true });
    const after = await vault.read(token);
    assert.equal(after.status, "submitted");
    assert.ok(after.stream);
    assert.deepEqual(await streamToBuffer(after.stream), Buffer.from(content));
  });
});

test("unknown token rejects submit and read", async () => {
  await withVault(async (vault) => {
    await assert.rejects(
      vault.submit("nope", bytesOf(new TextEncoder().encode("x"))),
      (err: unknown) => err instanceof VaultError && err.code === "token_not_found",
    );
    await assert.rejects(
      vault.read("nope"),
      (err: unknown) => err instanceof VaultError && err.code === "token_not_found",
    );
  });
});
