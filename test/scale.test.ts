import { test } from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import { compareConfigs, key } from '../src/index';
import type { Path } from '../src/index';

function buildConfig(groups: number, fields: number): Record<string, Record<string, number>> {
  const root: Record<string, Record<string, number>> = {};
  for (let g = 0; g < groups; g += 1) {
    const obj: Record<string, number> = {};
    for (let f = 0; f < fields; f += 1) {
      obj[`f${f}`] = g * 1000 + f;
    }
    root[`g${g}`] = obj;
  }
  return root;
}

test('scale: 100k nodes, 1000 registered paths, report matches independent expectation', () => {
  const baselineObj = buildConfig(1000, 100); // 1 + 1000 + 100_000 nodes
  const currentObj = buildConfig(1000, 100);
  // Three registered leaf changes.
  currentObj.g0.f5 = -1;
  currentObj.g1.f5 = -1;
  currentObj.g2.f5 = -1;
  // One unregistered leaf change.
  currentObj.g20.f7 = -1;
  // One group removed entirely (its registered path becomes missing).
  delete currentObj.g10;
  // One group added at the root.
  (currentObj as Record<string, unknown>).extra = { f0: 1 };
  // One registered value respelled equivalently: no drift expected.
  baselineObj.g30.f5 = 305; // unique literal below
  currentObj.g30.f5 = 305;

  const baselineText = JSON.stringify(baselineObj);
  const currentText = JSON.stringify(currentObj).replace('"f5":305', '"f5":305.0');

  const registry: Path[] = [];
  for (let g = 0; g < 1000; g += 1) {
    registry.push([key(`g${g}`), key('f5')]);
  }

  const start = Date.now();
  const report = compareConfigs(baselineText, currentText, registry);
  const elapsed = Date.now() - start;

  // Independently derived expectation:
  //   critical: g0.f5, g1.f5, g2.f5 modified + g10 removed = 4
  //   medium:   g20.f7 modified (unregistered) = 1
  //   low:      extra added = 1
  equal(report.entries.length, 6);
  deepEqual(report.counts, { critical: 4, medium: 1, low: 1 });
  equal(report.score, 100 - 4 * 15 - 5 - 2);
  ok(elapsed < 5000, `comparison took ${elapsed}ms`);
});

test('scale: 10 MiB of text with no drift returns quickly', () => {
  const big: Record<string, string> = {};
  let size = 0;
  let i = 0;
  while (size < 4_500_000) {
    const k = `key${i}`;
    const v = 'x'.repeat(100) + i;
    big[k] = v;
    size += k.length + v.length + 7;
    i += 1;
  }
  const text = JSON.stringify(big);
  const start = Date.now();
  const report = compareConfigs(text, text);
  ok(Date.now() - start < 5000);
  equal(report.entries.length, 0);
  equal(report.score, 100);
});

test('deep nesting at 128 levels is compared and classified', () => {
  const depth = 128;
  const seg = (s: string) => key(s);
  const registryPath = Array.from({ length: depth }, () => seg('a'));
  const wrap = (innermost: string) => {
    let s = innermost;
    for (let i = 0; i < depth; i += 1) s = `{"a":${s}}`;
    return s;
  };
  const report = compareConfigs(wrap('1'), wrap('2'), [registryPath]);
  equal(report.entries.length, 1);
  equal(report.entries[0].severity, 'critical');
  equal(report.entries[0].path.length, depth);
  equal(report.score, 85);
});

test('registered root path makes any drift Critical', () => {
  const report = compareConfigs('{"a":1}', '{"a":2}', [[]]);
  equal(report.entries[0].severity, 'critical');
});
