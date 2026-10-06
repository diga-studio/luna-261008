import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareConfigs } from '../src/index.js';
import type { Path } from '../src/index.js';

const KEY_COUNT = 14000; // ~98k nodes per document
const BASE_ID = 9007199254741000;

function buildDocs() {
  const baseParts: string[] = [];
  const curParts: string[] = [];
  const changedIds = [10, 5000, 9000, 12000, 13999];
  const flippedFlags = [20, 6000, 11000];
  const removedKeys = [30, 7000];
  const addedKeys = ['newA', 'newB'];
  for (let i = 0; i < KEY_COUNT; i++) {
    const id = BigInt(BASE_ID) + BigInt(i); // exact beyond float precision
    const flag = flippedFlags.includes(i) ? 'false' : 'true';
    if (!removedKeys.includes(i)) {
      baseParts.push(`"k${i}":{"id":${id},"flag":true,"list":[1,2,3]}`);
    }
    let curId: string;
    if (changedIds.includes(i)) {
      curId = String(id + 1n); // real drift beyond float precision
    } else if (i % 3 === 0) {
      curId = `${id}.0`; // equivalent respelling
    } else if (i % 3 === 1) {
      curId = `${id}0e-1`; // equivalent respelling
    } else {
      curId = String(id);
    }
    curParts.push(`"k${i}":{"id":${curId},"flag":${flag},"list":[1,2,3]}`);
  }
  for (const key of addedKeys) {
    curParts.push(`"${key}":{"id":1,"flag":true,"list":[]}`);
  }
  // Large equal payload to push total text towards the 10 MiB budget.
  const padding = 'x'.repeat(3_500_000);
  baseParts.push(`"padding":"${padding}"`);
  curParts.push(`"padding":"${padding}"`);
  const registry: Path[] = changedIds.map((i) => [`k${i}`, 'id']);
  for (let i = 0; registry.length < 1000; i++) registry.push(['absent', i]);
  return {
    baseline: '{' + baseParts.join(',') + '}',
    current: '{' + curParts.join(',') + '}',
    registry,
    expected: {
      critical: changedIds.length,
      medium: flippedFlags.length,
      low: removedKeys.length + addedKeys.length,
    },
  };
}

test('scale: ~100k nodes, 1000 registered paths, ~7 MiB of text', () => {
  const { baseline, current, registry, expected } = buildDocs();
  const totalBytes = Buffer.byteLength(baseline, 'utf8') + Buffer.byteLength(current, 'utf8');
  assert.ok(totalBytes > 7_000_000, `expected large input, got ${totalBytes}`);
  assert.ok(totalBytes < 10_485_760, `input exceeds 10 MiB budget: ${totalBytes}`);

  const start = performance.now();
  const report = compareConfigs(baseline, current, registry);
  const elapsed = performance.now() - start;

  assert.deepEqual(report.counts, expected);
  const expectedScore = Math.max(
    0,
    100 - expected.critical * 15 - expected.medium * 5 - expected.low * 2,
  );
  assert.equal(report.score, expectedScore);
  assert.ok(elapsed < 5000, `comparison took ${elapsed.toFixed(0)}ms`);

  // Every critical diff reports the exact big-integer literals on both sides.
  for (const diff of report.diffs) {
    if (diff.severity !== 'critical') continue;
    const key = diff.path[0] as string;
    const id = BigInt(BASE_ID) + BigInt(Number(key.slice(1)));
    assert.equal((diff.baseline as { raw: string }).raw, String(id));
    assert.equal((diff.current as { raw: string }).raw, String(id + 1n));
  }
});

test('deep nesting: drift at depth 128 is located precisely', () => {
  const depth = 128;
  let baseline = '1';
  let current = '2';
  const path: Path = [];
  for (let i = 0; i < depth; i++) {
    baseline = `{"n${i}":${baseline}}`;
    current = `{"n${i}":${current}}`;
    path.unshift(`n${i}`);
  }
  const report = compareConfigs(baseline, current, [path]);
  assert.equal(report.diffs.length, 1);
  assert.deepEqual(report.diffs[0].path, path);
  assert.equal(report.diffs[0].severity, 'critical');
  assert.equal(report.score, 85);
});
