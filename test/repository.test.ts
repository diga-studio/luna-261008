import { test } from "node:test";
import assert from "node:assert/strict";
import { Repository, type UploadHandle } from "../src/repository.js";
import {
  HandleRetiredError,
  InvalidPromotionError,
  UnknownHandleError,
  VersionExistsError,
} from "../src/errors.js";
import {
  HookedStore,
  chunksOf,
  makeTempDir,
  patternBytes,
  putVersions,
  readAll,
} from "./helpers.js";

function setup(retainCount?: number): { repo: Repository; store: HookedStore } {
  const store = new HookedStore(makeTempDir());
  const repo = new Repository(
    retainCount === undefined ? { store } : { store, retainCount },
  );
  return { repo, store };
}

test("put then open round-trips content through small chunks", async () => {
  const { repo } = setup();
  const data = patternBytes(3 * 1024 * 1024 + 13);
  const handle = await repo.put("1.0.0", chunksOf(data, 1024 * 1024));
  const received = await readAll(repo.open(handle));
  assert.deepEqual(received, data);
});

test("duplicate visible version is rejected and does not overwrite", async () => {
  const { repo } = setup();
  const first = await repo.put("1.0.0", chunksOf(Buffer.from("first"), 3));
  await assert.rejects(
    repo.put("1.0.0", chunksOf(Buffer.from("second"), 3)),
    VersionExistsError,
  );
  const received = await readAll(repo.open(first));
  assert.equal(received.toString(), "first");
});

test("promotion only allows dev -> staging -> production", async () => {
  const { repo } = setup();
  const handle = await repo.put("1.0.0", chunksOf(Buffer.from("x"), 1));
  assert.throws(() => repo.promote(handle, "production"), InvalidPromotionError);
  repo.promote(handle, "staging");
  assert.throws(() => repo.promote(handle, "dev"), InvalidPromotionError);
  assert.throws(() => repo.promote(handle, "staging"), InvalidPromotionError);
  repo.promote(handle, "production");
});

test("unknown handle is rejected", async () => {
  const { repo } = setup();
  const bogus: UploadHandle = { id: "upload-999", version: "9.9.9" };
  assert.throws(() => repo.promote(bogus, "staging"), UnknownHandleError);
  assert.throws(() => repo.open(bogus), UnknownHandleError);
});

test("concurrent duplicate puts: exactly one wins, content is not overwritten", async () => {
  const { repo } = setup();
  const results = await Promise.allSettled([
    repo.put("1.0.0", chunksOf(Buffer.from("upload-A"), 3)),
    repo.put("1.0.0", chunksOf(Buffer.from("upload-B"), 3)),
  ]);
  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 1);
  assert.ok((failed[0] as PromiseRejectedResult).reason instanceof VersionExistsError);
  const winner = (succeeded[0] as PromiseFulfilledResult<UploadHandle>).value;
  const received = await readAll(repo.open(winner));
  assert.match(received.toString(), /^upload-[AB]$/);
});

test("collect keeps the 25 highest-precedence non-production versions", async () => {
  const { repo } = setup();
  const versions = Array.from({ length: 27 }, (_, i) => `${i + 1}.0.0`);
  const handles = await putVersions(repo, versions);
  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version).sort(),
    ["1.0.0", "2.0.0"],
  );
  assert.throws(() => repo.open(handles.get("1.0.0")!), HandleRetiredError);
  assert.throws(() => repo.open(handles.get("2.0.0")!), HandleRetiredError);
  const kept = await readAll(repo.open(handles.get("10.0.0")!));
  assert.equal(kept.toString(), "content-of-10.0.0");
});

test("production versions are exempt and do not consume retention slots", async () => {
  const { repo } = setup();
  const versions = Array.from({ length: 28 }, (_, i) => `${i + 1}.0.0`);
  const handles = await putVersions(repo, versions);
  for (const v of ["1.0.0", "2.0.0"]) {
    repo.promote(handles.get(v)!, "staging");
    repo.promote(handles.get(v)!, "production");
  }
  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version),
    ["3.0.0"],
  );
  assert.ok(repo.open(handles.get("1.0.0")!));
  assert.ok(repo.open(handles.get("2.0.0")!));
});

test("equal precedence (build metadata) is broken by publish order", async () => {
  const { repo } = setup();
  const versions = [
    "1.0.0+build.1",
    "1.0.0+build.2",
    ...Array.from({ length: 24 }, (_, i) => `${i + 2}.0.0`),
  ];
  const handles = await putVersions(repo, versions);
  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version),
    ["1.0.0+build.1"],
  );
  assert.ok(repo.open(handles.get("1.0.0+build.2")!));
});

test("prerelease precedence drives retention", async () => {
  const { repo } = setup(2);
  const handles = await putVersions(repo, ["1.0.0-rc.1", "1.0.0", "1.0.0-alpha"]);
  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version),
    ["1.0.0-alpha"],
  );
  assert.ok(repo.open(handles.get("1.0.0-rc.1")!));
  assert.ok(repo.open(handles.get("1.0.0")!));
});

test("a second collect with no excess retires nothing", async () => {
  const { repo } = setup();
  const versions = Array.from({ length: 27 }, (_, i) => `${i + 1}.0.0`);
  await putVersions(repo, versions);
  await repo.collect();
  assert.deepEqual(await repo.collect(), []);
});
