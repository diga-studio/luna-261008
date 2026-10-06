import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { compareConfigs, key, index } from '../src/index';

test('registered path equal to the drift path is Critical', () => {
  const r = compareConfigs('{"a":1}', '{"a":2}', [[key('a')]]);
  equal(r.entries[0].severity, 'critical');
});

test('registered ancestor makes nested drifts Critical', () => {
  const r = compareConfigs('{"a":{"b":1,"c":2}}', '{"a":{"b":9,"c":8}}', [[key('a')]]);
  deepEqual(r.entries.map((e) => e.severity), ['critical', 'critical']);
  equal(r.score, 70);
});

test('registered descendant of a real change makes the parent drift Critical', () => {
  const r = compareConfigs('{"a":{"b":1}}', '{"a":{"b":2}}', [[key('a'), key('b')]]);
  equal(r.entries.length, 1);
  deepEqual(r.entries[0].path, [key('a'), key('b')]);
  equal(r.entries[0].severity, 'critical');
});

test('parent added: registered descendant counts as changed', () => {
  const r = compareConfigs('{}', '{"a":{"b":1}}', [[key('a'), key('b')]]);
  equal(r.entries.length, 1);
  equal(r.entries[0].kind, 'added');
  equal(r.entries[0].severity, 'critical');
  equal(r.score, 85);
});

test('parent removed: registered descendant counts as changed', () => {
  const r = compareConfigs('{"a":{"b":1}}', '{}', [[key('a'), key('b')]]);
  equal(r.entries[0].kind, 'removed');
  equal(r.entries[0].severity, 'critical');
});

test('parent replaced by container: registered descendant counts as changed', () => {
  const r = compareConfigs('{"a":{"b":1}}', '{"a":[1]}', [[key('a'), key('b')]]);
  equal(r.entries[0].kind, 'modified');
  equal(r.entries[0].severity, 'critical');
});

test('parent replaced scalar-to-scalar: registered descendant missing on both sides, not Critical', () => {
  const r = compareConfigs('{"a":1}', '{"a":2}', [[key('a'), key('b')]]);
  equal(r.entries[0].kind, 'modified');
  equal(r.entries[0].severity, 'medium');
  equal(r.score, 95);
});

test('registered path missing on both sides is not a change', () => {
  const r = compareConfigs('{"a":1}', '{"a":2}', [[key('zzz')]]);
  equal(r.entries[0].severity, 'medium');
  const r2 = compareConfigs('{"a":1}', '{"a":1,"b":2}', [[key('zzz')]]);
  equal(r2.entries[0].severity, 'low');
});

test('registered path pointing at a container compares its whole value', () => {
  const r = compareConfigs('{"a":{"x":1,"y":2}}', '{"a":{"x":1,"y":3}}', [[key('a')]]);
  equal(r.entries[0].severity, 'critical');
  // Same value spelled differently: no drift at all.
  const r2 = compareConfigs('{"a":{"y":2,"x":1}}', '{"a":{"x":1.0,"y":2}}', [[key('a')]]);
  equal(r2.entries.length, 0);
  equal(r2.score, 100);
});

test('registered path through array indices', () => {
  const r = compareConfigs('{"list":[{"id":1}]}', '{"list":[{"id":2}]}', [[key('list'), index(0), key('id')]]);
  equal(r.entries[0].severity, 'critical');
  const off = compareConfigs('{"list":[{"id":1}]}', '{"list":[{"id":2}]}', [[key('list'), index(1), key('id')]]);
  equal(off.entries[0].severity, 'medium');
});

test('unregistered modified is Medium, added/removed are Low', () => {
  const r = compareConfigs('{"m":1,"d":1}', '{"m":2,"a":1}');
  deepEqual(r.entries.map((e) => [e.kind, e.severity]), [
    ['modified', 'medium'],
    ['removed', 'low'],
    ['added', 'low'],
  ]);
  equal(r.score, 100 - 5 - 2 - 2);
});

test('dotted key segment does not match a nested path', () => {
  const r = compareConfigs('{"a.b":1}', '{"a.b":2}', [[key('a'), key('b')]]);
  equal(r.entries[0].severity, 'medium');
  const r2 = compareConfigs('{"a.b":1}', '{"a.b":2}', [[key('a.b')]]);
  equal(r2.entries[0].severity, 'critical');
});

test('escaped equivalent registered keys address the same drift', () => {
  const r = compareConfigs('{"\\u0061":1}', '{"a":2}', [[key('a')]]);
  equal(r.entries.length, 1);
  equal(r.entries[0].severity, 'critical');
});
