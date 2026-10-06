import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareConfigs } from '../src/index.js';

test('escaped-equivalent keys and strings produce no drift', () => {
  const report = compareConfigs(
    '{"A": "x", "slash/key": 1}',
    '{"A": "x", "slash/key": 1.0}',
    [],
  );
  assert.equal(report.diffs.length, 0);
  assert.equal(report.score, 100);
});

test('dotted key and nested path coexist as distinct locations', () => {
  const report = compareConfigs(
    '{"a.b": 1, "a": {"b": 1}}',
    '{"a.b": 2, "a": {"b": 1}}',
    [],
  );
  assert.equal(report.diffs.length, 1);
  assert.deepEqual(report.diffs[0].path, ['a.b']);
  assert.equal(report.diffs[0].kind, 'modified');
});

test('object key "0" differs from array index 0', () => {
  const report = compareConfigs('{"0": "v"}', '["v"]', []);
  assert.equal(report.diffs.length, 1);
  assert.deepEqual(report.diffs[0].path, []);
  assert.equal(report.diffs[0].kind, 'modified');
});

test('object key order does not affect the report', () => {
  const a = compareConfigs('{"x": 1, "y": 2}', '{"y": 3, "x": 9}', []);
  const b = compareConfigs('{"y": 2, "x": 1}', '{"x": 9, "y": 3}', []);
  assert.equal(a.score, b.score);
  assert.equal(a.diffs.length, 2);
  const paths = a.diffs.map((d) => JSON.stringify(d.path)).sort();
  assert.deepEqual(paths, ['["x"]', '["y"]']);
});

test('missing and null are distinguished', () => {
  const report = compareConfigs('{"a": null}', '{}', []);
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0].kind, 'removed');
  assert.deepEqual(report.diffs[0].path, ['a']);
  assert.equal(report.diffs[0].baseline?.type, 'null');
});

test('type change records one diff without expanding the subtree', () => {
  const report = compareConfigs(
    '{"svc": {"a": 1, "b": {"c": 2}}}',
    '{"svc": [1, 2, 3]}',
    [],
  );
  assert.equal(report.diffs.length, 1);
  assert.deepEqual(report.diffs[0].path, ['svc']);
  assert.equal(report.diffs[0].kind, 'modified');
  assert.equal(report.diffs[0].baseline?.type, 'object');
  assert.equal(report.diffs[0].current?.type, 'array');
});

test('array order changes count as drift', () => {
  const report = compareConfigs('[1, 2]', '[2, 1]', []);
  assert.equal(report.diffs.length, 2);
  assert.deepEqual(report.diffs[0].path, [0]);
  assert.deepEqual(report.diffs[1].path, [1]);
});

test('number is never equal to string or boolean', () => {
  const report = compareConfigs('{"n": 1, "b": true}', '{"n": "1", "b": 1}', []);
  assert.equal(report.diffs.length, 2);
  assert.ok(report.diffs.every((d) => d.kind === 'modified'));
});

test('reported values keep raw number literals', () => {
  const report = compareConfigs('{"p": 9007199254740992}', '{"p": 9.007199254740993e15}', []);
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0].baseline?.type, 'number');
  assert.equal((report.diffs[0].baseline as { raw: string }).raw, '9007199254740992');
  assert.equal((report.diffs[0].current as { raw: string }).raw, '9.007199254740993e15');
});

test('root can be any JSON value', () => {
  assert.equal(compareConfigs('1', '1.0', []).diffs.length, 0);
  assert.equal(compareConfigs('"a"', '"b"', []).diffs.length, 1);
  assert.equal(compareConfigs('null', '0', []).diffs.length, 1);
});
