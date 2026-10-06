import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { compareConfigs, key, index } from '../src/index';
import type { DriftEntry } from '../src/index';

function entriesOf(a: string, b: string): readonly DriftEntry[] {
  return compareConfigs(a, b).entries;
}

test('identical configs produce no drift, score 100', () => {
  const r = compareConfigs('{"a":1,"b":[true,null]}', '{ "b" : [ true , null ], "a": 1.0 }');
  equal(r.entries.length, 0);
  equal(r.score, 100);
});

test('object key order does not matter', () => {
  equal(entriesOf('{"x":1,"y":2}', '{"y":2,"x":1}').length, 0);
});

test('array order matters and indices align', () => {
  const e = entriesOf('[1,2,3]', '[1,3,2]');
  equal(e.length, 2);
  equal(e[0].kind, 'modified');
  deepEqual(e[0].path, [index(1)]);
  deepEqual(e[1].path, [index(2)]);
});

test('added and removed are single entries without subtree expansion', () => {
  const e = entriesOf('{"a":{"x":1,"y":2},"b":1}', '{"b":1,"c":[1,2]}');
  equal(e.length, 2);
  equal(e[0].kind, 'removed');
  deepEqual(e[0].path, [key('a')]);
  deepEqual(e[0].baseline, { type: 'object', value: { x: { type: 'number', raw: '1' }, y: { type: 'number', raw: '2' } } });
  equal(e[1].kind, 'added');
  deepEqual(e[1].path, [key('c')]);
});

test('type change is one modified entry, subtree not expanded', () => {
  const e = entriesOf('{"a":{"x":1}}', '{"a":5}');
  equal(e.length, 1);
  equal(e[0].kind, 'modified');
  deepEqual(e[0].path, [key('a')]);
  deepEqual(e[0].baseline, { type: 'object', value: { x: { type: 'number', raw: '1' } } });
  deepEqual(e[0].current, { type: 'number', raw: '5' });
});

test('missing is distinct from null', () => {
  const e = entriesOf('{"a":null}', '{}');
  equal(e.length, 1);
  equal(e[0].kind, 'removed');
  const e2 = entriesOf('{"a":null}', '{"a":0}');
  equal(e2.length, 1);
  equal(e2[0].kind, 'modified');
});

test('number is never equal to string, boolean or null', () => {
  for (const [a, b] of [['1', '"1"'], ['1', 'true'], ['0', 'null'], ['0', 'false']]) {
    const e = entriesOf(`{"v":${a}}`, `{"v":${b}}`);
    equal(e.length, 1, `${a} vs ${b}`);
    equal(e[0].kind, 'modified');
  }
});

test('object key "0" differs from array index 0', () => {
  const e = entriesOf('{"0":"a"}', '["a"]');
  equal(e.length, 1);
  equal(e[0].kind, 'modified');
  deepEqual(e[0].path, []);
});

test('escaped key spellings decode to the same key', () => {
  equal(entriesOf('{"a":1}', '{"\\u0061":1}').length, 0);
  equal(entriesOf('{"\\u0041\\u0042":1}', '{"AB":2}').length, 1);
});

test('empty, dotted and slashed keys are addressed as single segments', () => {
  const e = entriesOf('{"":{"a.b":{"x/y":1}}}', '{"":{"a.b":{"x/y":2}}}');
  equal(e.length, 1);
  deepEqual(e[0].path, [key(''), key('a.b'), key('x/y')]);
});

test('root may be any JSON value', () => {
  equal(entriesOf('1', '1.0').length, 0);
  equal(entriesOf('"a"', '"b"').length, 1);
  equal(entriesOf('null', 'null').length, 0);
  const e = entriesOf('[1]', '{"0":1}');
  equal(e.length, 1);
  deepEqual(e[0].path, []);
});

test('report keeps raw number literals on both sides', () => {
  const e = entriesOf('{"v":1e1000000000}', '{"v":2.500e3}');
  deepEqual(e[0].baseline, { type: 'number', raw: '1e1000000000' });
  deepEqual(e[0].current, { type: 'number', raw: '2.500e3' });
});

test('no unicode normalization: canonically different strings differ', () => {
  const e = entriesOf('{"v":"é"}', '{"v":"e\\u0301"}');
  equal(e.length, 1);
  const k = entriesOf('{"é":1}', '{"e\\u0301":1}');
  equal(k.length, 2);
  equal(k[0].kind, 'removed');
  equal(k[1].kind, 'added');
});
