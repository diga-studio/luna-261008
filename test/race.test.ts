import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Repository, type UploadHandle } from "../src/repository.js";
import { HandleRetiredError } from "../src/errors.js";
import {
  Deferred,
  HookedStore,
  chunksOf,
  makeTempDir,
  patternBytes,
  putVersions,
  readAll,
} from "./helpers.js";

test("collect re-validates candidates after interleaved promotions", async () => {
  const store = new HookedStore(makeTempDir());
  const candidatesSeen = new Deferred<readonly UploadHandle[]>();
  const resume = new Deferred<void>();
  let hookCalls = 0;
  const repo = new Repository({
    store,
    hooks: {
      onCollectCandidates: (candidates) => {
        hookCalls++;
        if (hookCalls === 1) {
          candidatesSeen.resolve(candidates);
          return resume.promise;
        }
      },
    },
  });
  const versions = Array.from({ length: 27 }, (_, i) => `${i + 1}.0.0`);
  const handles = await putVersions(repo, versions);

  const collectPromise = repo.collect();
  const candidates = await candidatesSeen.promise;

  // SemVer precedence, not string ordering: the two lowest are 1.0.0 and 2.0.0.
  // String ordering would have picked 1.0.0 and 10.0.0 instead.
  assert.deepEqual(
    candidates.map((h) => h.version),
    ["2.0.0", "1.0.0"],
  );

  // Promote the lowest candidate and an originally retained newer version.
  for (const v of ["1.0.0", "27.0.0"]) {
    repo.promote(handles.get(v)!, "staging");
    repo.promote(handles.get(v)!, "production");
  }
  resume.resolve();

  const retired = await collectPromise;
  assert.deepEqual(retired, []);

  // Both old candidates survive: 1.0.0 is production-exempt, 2.0.0 is back in
  // the retained top 25 now that two versions left the non-production pool.
  assert.equal(
    (await readAll(repo.open(handles.get("1.0.0")!))).toString(),
    "content-of-1.0.0",
  );
  assert.equal(
    (await readAll(repo.open(handles.get("2.0.0")!))).toString(),
    "content-of-2.0.0",
  );
  assert.equal(hookCalls, 1);
});

test("re-upload during paused physical delete; old handle stays dead", async () => {
  const store = new HookedStore(makeTempDir());
  const repo = new Repository({ store });
  const oldHandle = await repo.put("1.0.0", chunksOf(Buffer.from("old-content"), 4));
  await putVersions(repo, Array.from({ length: 25 }, (_, i) => `${i + 2}.0.0`));

  const deleteStarted = store.expectNextDelete();
  const gate = new Deferred<void>();
  store.setDeleteGate(gate.promise);

  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version),
    ["1.0.0"],
  );
  const oldFileKey = await deleteStarted;

  // Logical retirement is immediate: the same version can be re-uploaded even
  // though the old file's physical deletion is still blocked.
  const newHandle = await repo.put("1.0.0", chunksOf(Buffer.from("new-content"), 4));
  assert.notEqual(newHandle.id, oldHandle.id);
  assert.notEqual(`${newHandle.id}.bin`, oldFileKey);
  assert.equal((await readAll(repo.open(newHandle))).toString(), "new-content");

  // The old handle cannot access or promote the new upload.
  assert.throws(() => repo.open(oldHandle), HandleRetiredError);
  assert.throws(() => repo.promote(oldHandle, "staging"), HandleRetiredError);

  // Resume the paused deletion: it must only remove the old file.
  gate.resolve();
  await repo.settled();
  assert.deepEqual(store.deletedKeys, [oldFileKey]);
  assert.ok(!store.fileExists(oldFileKey));
  assert.ok(store.fileExists(`${newHandle.id}.bin`));
  assert.equal((await readAll(repo.open(newHandle))).toString(), "new-content");
});

test("stream opened before collect survives: full consumption", async () => {
  const store = new HookedStore(makeTempDir());
  const repo = new Repository({ store });
  const data = patternBytes(3 * 1024 * 1024 + 7);
  const handle = await repo.put("1.0.0", chunksOf(data, 1024 * 1024));
  await putVersions(repo, Array.from({ length: 25 }, (_, i) => `${i + 2}.0.0`));

  const stream = repo.open(handle);
  const closed = once(stream, "close");

  // Collect must return without waiting for the open stream; the version is
  // logically retired while the file is kept alive for this stream.
  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version),
    ["1.0.0"],
  );
  assert.throws(() => repo.open(handle), HandleRetiredError);
  assert.ok(store.fileExists(`${handle.id}.bin`));

  // The paused download resumes and matches the original bytes exactly.
  const received = await readAll(stream);
  assert.deepEqual(received, data);

  await closed;
  await repo.settled();
  assert.ok(!store.fileExists(`${handle.id}.bin`));
});

test("stream opened before collect survives: early close releases file", async () => {
  const store = new HookedStore(makeTempDir());
  const repo = new Repository({ store });
  const data = patternBytes(3 * 1024 * 1024 + 7);
  const handle = await repo.put("1.0.0", chunksOf(data, 1024 * 1024));
  await putVersions(repo, Array.from({ length: 25 }, (_, i) => `${i + 2}.0.0`));

  const stream = repo.open(handle);
  const closed = once(stream, "close");

  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version),
    ["1.0.0"],
  );
  assert.ok(store.fileExists(`${handle.id}.bin`));

  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  const bytesRead = (first.value as Buffer).length;
  assert.ok(bytesRead > 0);
  stream.destroy();

  await closed;
  await repo.settled();
  assert.ok(!store.fileExists(`${handle.id}.bin`));
});
