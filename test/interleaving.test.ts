import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Handle } from '../src/repository';
import type { VersionInfo } from '../src/types';
import {
  expectedContent,
  makeGate,
  makeRepo,
  pathExists,
  putVersion,
  readAll,
} from './helpers';

/**
 * Spec case 1: Collect pauses after selecting the two lowest candidates.
 * Promoting the lowest candidate and a previously-retained newer version to
 * production before the cleanup resumes must protect both old candidates.
 */
test('promotion during paused collect protects selected candidates', async (t) => {
  const candidatesReady = makeGate();
  const resume = makeGate();
  let seen: VersionInfo[] = [];
  const { repo, cleanup } = await makeRepo({
    afterCollectCandidates: async (candidates) => {
      seen = candidates;
      candidatesReady.resolve();
      await resume.promise;
    },
  });
  t.after(cleanup);

  const handles = new Map<string, Handle>();
  for (let i = 1; i <= 27; i++) {
    handles.set(`0.${i}.0`, await putVersion(repo, `0.${i}.0`, 64, i));
  }

  const collectPromise = repo.collect();
  await candidatesReady.promise;

  // The two lowest by semver precedence. A lexicographic ordering would have
  // picked "0.1.0" and "0.10.0" instead.
  assert.deepEqual(
    seen.map((c) => c.version),
    ['0.1.0', '0.2.0'],
  );

  // Promote the lowest candidate and a newer version that was being retained.
  repo.promote(handles.get('0.1.0')!, 'staging');
  repo.promote(handles.get('0.1.0')!, 'production');
  repo.promote(handles.get('0.27.0')!, 'staging');
  repo.promote(handles.get('0.27.0')!, 'production');

  resume.resolve();
  const retired = await collectPromise;
  assert.deepEqual(retired, []);

  // Both old candidates survived: 0.1.0 as production, 0.2.0 back inside the
  // retained top-25 because two versions left the non-production pool.
  assert.deepEqual(await readAll(await repo.open(handles.get('0.1.0')!)), expectedContent(64, 1));
  assert.deepEqual(await readAll(await repo.open(handles.get('0.2.0')!)), expectedContent(64, 2));
  assert.deepEqual(await repo.collect(), []);
});

/**
 * Spec case 2: physical deletion of a retired version is paused; the same
 * version string is re-uploaded immediately. The old delete must not touch
 * the new content, and the old handle must stay dead.
 */
test('re-upload during paused physical delete stays isolated', async (t) => {
  const deleteStarted = makeGate();
  const allowDelete = makeGate();
  let oldPath = '';
  const { repo, cleanup } = await makeRepo({
    beforePhysicalDelete: async (info) => {
      oldPath = info.path;
      deleteStarted.resolve();
      await allowDelete.promise;
    },
  });
  t.after(cleanup);

  const size = 2 * 1024 * 1024 + 13;
  const oldHandle = await putVersion(repo, '1.0.0', size, 1);
  for (let i = 1; i <= 25; i++) {
    await putVersion(repo, `1.0.${i}`, 16, 100 + i);
  }

  // Logical retirement returns without waiting for the physical delete.
  const retired = await repo.collect();
  assert.deepEqual(retired.map((h) => h.id), [oldHandle.id]);
  await deleteStarted.promise;
  assert.equal(oldHandle.version, '1.0.0');

  // Re-upload the same version string while the old file is still on disk.
  const newHandle = await putVersion(repo, '1.0.0', size, 2);
  assert.notEqual(newHandle.id, oldHandle.id);
  assert.deepEqual(await readAll(await repo.open(newHandle)), expectedContent(size, 2));

  // The old handle can neither read nor promote the new content.
  await assert.rejects(repo.open(oldHandle), /no longer valid/);
  assert.throws(() => repo.promote(oldHandle, 'staging'), /no longer valid/);

  // Resume the old deletion: old file disappears, new content stays intact.
  allowDelete.resolve();
  await repo.whenIdle();
  assert.equal(await pathExists(oldPath), false);
  assert.deepEqual(await readAll(await repo.open(newHandle)), expectedContent(size, 2));
  assert.deepEqual(repo.physicalDeleteErrors, []);
});

/**
 * Spec case 3: a download opened before collection keeps reading the original
 * bytes even after the version is retired; the file is released once the last
 * reader finishes or closes, without another Collect.
 */
test('open download survives collection; file released after full read', async (t) => {
  let deletedPath = '';
  const deleted = makeGate();
  const { repo, cleanup } = await makeRepo({
    beforePhysicalDelete: (info) => {
      deletedPath = info.path;
    },
    afterPhysicalDelete: () => {
      deleted.resolve();
    },
  });
  t.after(cleanup);

  const size = 3 * 1024 * 1024 + 123;
  const handle = await putVersion(repo, '0.1.0', size, 9);
  for (let i = 2; i <= 26; i++) {
    await putVersion(repo, `0.${i}.0`, 16, 50 + i);
  }

  // Open, then pause before reading the first chunk.
  const download = await repo.open(handle);

  // Collect retires the version and returns without waiting for the reader.
  const retired = await repo.collect();
  assert.deepEqual(retired.map((h) => h.id), [handle.id]);
  await assert.rejects(repo.open(handle), /no longer valid/);

  // The in-flight stream still delivers every original byte.
  const data = await readAll(download);
  assert.deepEqual(data, expectedContent(size, 9));

  // After the last reader finished, the file is released on its own.
  await deleted.promise;
  await repo.whenIdle();
  assert.equal(await pathExists(deletedPath), false);
  assert.deepEqual(repo.physicalDeleteErrors, []);
});

test('open download survives collection; file released after early close', async (t) => {
  let deletedPath = '';
  const deleted = makeGate();
  const { repo, cleanup } = await makeRepo({
    beforePhysicalDelete: (info) => {
      deletedPath = info.path;
    },
    afterPhysicalDelete: () => {
      deleted.resolve();
    },
  });
  t.after(cleanup);

  const size = 3 * 1024 * 1024 + 321;
  const handle = await putVersion(repo, '0.1.0', size, 7);
  for (let i = 2; i <= 26; i++) {
    await putVersion(repo, `0.${i}.0`, 16, 70 + i);
  }

  const download = await repo.open(handle);
  const retired = await repo.collect();
  assert.deepEqual(retired.map((h) => h.id), [handle.id]);

  // Read only the first chunk, then close early.
  const iterator = download[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  const expected = expectedContent(size, 7);
  assert.deepEqual(Buffer.from(first.value as Uint8Array), expected.subarray(0, first.value!.length));
  await download.close();

  await deleted.promise;
  await repo.whenIdle();
  assert.equal(await pathExists(deletedPath), false);
  assert.deepEqual(repo.physicalDeleteErrors, []);
});
