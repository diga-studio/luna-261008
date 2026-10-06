import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Handle } from '../src/repository';
import {
  expectedContent,
  makeGate,
  makeRepo,
  makeSource,
  pathExists,
  putVersion,
  readAll,
} from './helpers';

test('basic lifecycle: put, open, promote through stages', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const handle = await putVersion(repo, '1.2.3', 3 * 1024 * 1024 + 7, 1);
  assert.equal(handle.version, '1.2.3');

  const data = await readAll(await repo.open(handle));
  assert.deepEqual(data, expectedContent(3 * 1024 * 1024 + 7, 1));

  assert.throws(() => repo.promote(handle, 'production'), /illegal stage transition/);
  repo.promote(handle, 'staging');
  assert.throws(() => repo.promote(handle, 'staging'), /illegal stage transition/);
  repo.promote(handle, 'production');
  assert.throws(() => repo.promote(handle, 'staging'), /illegal stage transition/);
});

test('put rejects duplicate visible version and invalid semver', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  await putVersion(repo, '1.0.0', 16, 1);
  await assert.rejects(repo.put('1.0.0', makeSource(16, 2)), /already exists/);
  await assert.rejects(repo.put('not-a-version', makeSource(16, 3)));
  // Build metadata makes strings distinct; both may coexist.
  await putVersion(repo, '1.0.0+other', 16, 4);
});

test('failed upload cleans up temporary files', async (t) => {
  const { repo, dir, cleanup } = await makeRepo();
  t.after(cleanup);

  async function* failing(): AsyncIterable<Uint8Array> {
    yield Buffer.alloc(10, 1);
    throw new Error('source exploded');
  }
  await assert.rejects(repo.put('2.0.0', failing()), /source exploded/);
  const tmpEntries = await fsp.readdir(path.join(dir, 'tmp'));
  const blobEntries = await fsp.readdir(path.join(dir, 'blobs'));
  assert.deepEqual(tmpEntries, []);
  assert.deepEqual(blobEntries, []);
  // Version was never published; retry succeeds.
  await putVersion(repo, '2.0.0', 32, 5);
});

test('collect keeps 25 highest semver precedence versions, not string order', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  // 27 versions 0.1.0 .. 0.27.0. Lexicographic order would rank "0.10.0"
  // below "0.2.0"; semver precedence ranks 0.2.0 below 0.10.0.
  const handles = new Map<string, Handle>();
  for (let i = 1; i <= 27; i++) {
    handles.set(`0.${i}.0`, await putVersion(repo, `0.${i}.0`, 64, i));
  }
  const retired = await repo.collect();
  const retiredVersions = retired.map((h) => h.version).sort();
  assert.deepEqual(retiredVersions, ['0.1.0', '0.2.0']);

  // Retired handles are dead; kept handles still work.
  assert.throws(() => repo.promote(handles.get('0.1.0')!, 'staging'), /no longer valid/);
  await assert.rejects(repo.open(handles.get('0.2.0')!), /no longer valid/);
  const kept = await readAll(await repo.open(handles.get('0.3.0')!));
  assert.deepEqual(kept, expectedContent(64, 3));

  // Idempotent: nothing left to collect.
  assert.deepEqual(await repo.collect(), []);
});

test('production versions are exempt and do not consume retention slots', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  // 1 production + 25 non-production: nothing is collected.
  const prod = await putVersion(repo, '0.0.1', 16, 1);
  repo.promote(prod, 'staging');
  repo.promote(prod, 'production');
  for (let i = 2; i <= 26; i++) {
    await putVersion(repo, `0.0.${i}`, 16, i);
  }
  assert.deepEqual(await repo.collect(), []);
  // One more non-production version exceeds the budget; the lowest is retired.
  const extra = await putVersion(repo, '0.0.27', 16, 27);
  const retired = await repo.collect();
  assert.deepEqual(retired.map((h) => h.version), ['0.0.2']);
  assert.ok(await repo.open(extra));
});

test('equal precedence (build metadata) keeps the later published upload', async (t) => {
  const { repo, cleanup } = await makeRepo({}, 1);
  t.after(cleanup);

  const older = await putVersion(repo, '1.0.0+aaa', 16, 1);
  const newer = await putVersion(repo, '1.0.0+bbb', 16, 2);
  const retired = await repo.collect();
  assert.deepEqual(retired.map((h) => h.id), [older.id]);
  const data = await readAll(await repo.open(newer));
  assert.deepEqual(data, expectedContent(16, 2));
});

test('prerelease identifiers participate in retention ordering', async (t) => {
  const { repo, cleanup } = await makeRepo({}, 2);
  t.after(cleanup);

  const alpha = await putVersion(repo, '1.0.0-alpha', 16, 1);
  await putVersion(repo, '1.0.0-beta', 16, 2);
  await putVersion(repo, '1.0.0', 16, 3);
  const retired = await repo.collect();
  assert.deepEqual(retired.map((h) => h.id), [alpha.id]);
});

test('large upload streams in bounded chunks and downloads byte-exact', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const size = 32 * 1024 * 1024 + 999;
  const handle = await putVersion(repo, '5.0.0', size, 42);
  const download = await repo.open(handle);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of download) {
    assert.ok(chunk.byteLength <= 1024 * 1024, 'download chunk exceeds 1 MiB');
    total += chunk.byteLength;
    parts.push(Buffer.from(chunk));
  }
  assert.equal(total, size);
  assert.deepEqual(Buffer.concat(parts), expectedContent(size, 42));
});

test('concurrent puts of the same version: exactly one wins', async (t) => {
  const { repo, cleanup } = await makeRepo();
  t.after(cleanup);

  const slow = makeGate();
  async function* slowSource(): AsyncIterable<Uint8Array> {
    yield Buffer.from(expectedContent(64, 1));
    await slow.promise;
    yield Buffer.from(expectedContent(64, 1));
  }
  const first = repo.put('3.1.4', slowSource());
  // Give the first upload a chance to start, then race a second one.
  const second = repo.put('3.1.4', makeSource(64, 2));
  slow.resolve();
  const [winner, loser] = await Promise.allSettled([first, second]);
  const fulfilled = [winner, loser].filter((r) => r.status === 'fulfilled');
  const rejected = [winner, loser].filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String((rejected[0] as PromiseRejectedResult).reason), /already exists/);
});

test('a single collect retires all excess versions at once', async (t) => {
  const { repo, cleanup } = await makeRepo({}, 3);
  t.after(cleanup);

  for (let i = 1; i <= 8; i++) {
    await putVersion(repo, `2.0.${i}`, 16, i);
  }
  const retired = await repo.collect();
  assert.deepEqual(
    retired.map((h) => h.version).sort(),
    ['2.0.1', '2.0.2', '2.0.3', '2.0.4', '2.0.5'],
  );
  assert.deepEqual(await repo.collect(), []);
});
