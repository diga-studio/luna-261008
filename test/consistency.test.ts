import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditModule, ProjectSpec } from '../src/index.js';
import { RefProject, assertSnapshotEquals, assertDonePredecessorsDone } from './helpers.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDag(rand: () => number, projectId: string, n: number, edgeCount: number): ProjectSpec {
  const steps = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, text: `doc-${i}` }));
  const edges: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  while (edges.length < edgeCount) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a === b) continue;
    const [from, to] = a < b ? [a, b] : [b, a];
    const key = `${from}-${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([`s${from}`, `s${to}`]);
  }
  return { projectId, steps, edges };
}

test('随机操作序列：快照与独立逐步计算一致，不变量保持', () => {
  for (const seed of [1, 2, 3]) {
    const rand = mulberry32(seed);
    const spec = randomDag(rand, 'p', 30, 60);
    const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));
    const m = new AuditModule(join(dir, 'test.db'));
    m.initProject(spec);
    const ref = new RefProject(spec);

    for (let i = 0; i < 300; i += 1) {
      const stepId = `s${Math.floor(rand() * 30)}`;
      const key = `k${i}`;
      const op = rand();
      const expectedVersion = Math.floor(rand() * 4);
      let actual;
      let expected;
      if (op < 0.4) {
        const text = rand() < 0.5 ? `text-${i}` : undefined;
        actual = m.submitReview('p', { requestKey: key, stepId, expectedVersion, text });
        expected = ref.submit(key, stepId, expectedVersion, text);
      } else if (op < 0.8) {
        actual = m.signOff('p', { requestKey: key, stepId, expectedVersion });
        expected = ref.signoff(key, stepId, expectedVersion);
      } else {
        actual = m.rework('p', { requestKey: key, stepId, expectedVersion });
        expected = ref.rework(key, stepId, expectedVersion);
      }
      assert.equal(actual.kind, expected.kind, `seed=${seed} i=${i} kind`);
      if (actual.kind === 'ok' && expected.kind === 'ok') {
        assert.deepEqual(
          actual.affected.map((s) => `${s.id}:${s.version}:${s.status}`).sort(),
          expected.affected.map((s) => `${s.id}:${s.version}:${s.status}`).sort(),
          `seed=${seed} i=${i} affected`,
        );
      }
    }

    const snap = m.getSnapshot('p');
    assertSnapshotEquals(snap, ref.snapshot());
    assertDonePredecessorsDone(spec, snap);
    m.close();
  }
});

test('规模冒烟：10000 步骤、50000 依赖下操作可用', () => {
  const rand = mulberry32(42);
  const spec = randomDag(rand, 'big', 10000, 50000);
  const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  const m = new AuditModule(join(dir, 'test.db'));
  m.initProject(spec);

  const r1 = m.submitReview('big', { requestKey: 'b1', stepId: 's0', expectedVersion: 0 });
  assert.equal(r1.kind, 'ok');
  const r2 = m.signOff('big', { requestKey: 'b2', stepId: 's0', expectedVersion: 1 });
  assert.equal(r2.kind, 'ok');
  const r3 = m.rework('big', { requestKey: 'b3', stepId: 's0', expectedVersion: 2 });
  assert.equal(r3.kind, 'ok');

  const snap = m.getSnapshot('big');
  assert.equal(snap.steps.length, 10000);
  assertDonePredecessorsDone(spec, snap);
  m.close();
});
