import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareConfigs } from '../src/index.js';

test('acceptance: permission id drift is Critical, equivalent respelling is ignored', () => {
  const report = compareConfigs(
    '{"permissionId": 9007199254740992, "timeout": 30}',
    '{"permissionId": 9007199254740993, "timeout": 3.0e1}',
    [['permissionId']],
  );
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0].severity, 'critical');
  assert.deepEqual(report.diffs[0].path, ['permissionId']);
  assert.deepEqual(report.counts, { critical: 1, medium: 0, low: 0 });
  assert.equal(report.score, 85);
});

test('added parent: registered path that appears is Critical, still-missing is Low', () => {
  const critical = compareConfigs('{}', '{"svc": {"token": "x"}}', [['svc', 'token']]);
  assert.equal(critical.diffs.length, 1);
  assert.equal(critical.diffs[0].kind, 'added');
  assert.equal(critical.diffs[0].severity, 'critical');
  assert.equal(critical.score, 85);

  const low = compareConfigs('{}', '{"svc": {"token": "x"}}', [['svc', 'other']]);
  assert.equal(low.diffs.length, 1);
  assert.equal(low.diffs[0].severity, 'low');
  assert.equal(low.score, 98);
});

test('removed parent: registered path that disappears is Critical, still-missing is Low', () => {
  const critical = compareConfigs('{"svc": {"token": "x"}}', '{}', [['svc', 'token']]);
  assert.equal(critical.diffs[0].kind, 'removed');
  assert.equal(critical.diffs[0].severity, 'critical');

  const low = compareConfigs('{"svc": {"token": "x"}}', '{}', [['svc', 'other']]);
  assert.equal(low.diffs[0].severity, 'low');
});

test('replaced parent: registered path resolution decides Critical vs Low', () => {
  const critical = compareConfigs('{"svc": {"token": "x"}}', '{"svc": [1]}', [['svc', 'token']]);
  assert.equal(critical.diffs.length, 1);
  assert.equal(critical.diffs[0].kind, 'modified');
  assert.equal(critical.diffs[0].severity, 'critical');

  const medium = compareConfigs('{"svc": {"token": "x"}}', '{"svc": [1]}', [['svc', 'missing']]);
  assert.equal(medium.diffs[0].severity, 'medium');
});

test('registered container path: any change inside makes related diffs Critical', () => {
  const report = compareConfigs(
    '{"svc": {"a": 1}, "other": 1}',
    '{"svc": {"a": 2}, "other": 2}',
    [['svc']],
  );
  const svcDiff = report.diffs.find((d) => d.path[0] === 'svc');
  const otherDiff = report.diffs.find((d) => d.path[0] === 'other');
  assert.equal(svcDiff?.severity, 'critical');
  assert.equal(otherDiff?.severity, 'medium');
  assert.equal(report.score, 100 - 15 - 5);
});

test('unrelated registered path does not raise severity', () => {
  const report = compareConfigs(
    '{"svc": {"keep": "v", "chg": 1}}',
    '{"svc": {"keep": "v", "chg": 2}}',
    [['svc', 'keep']],
  );
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0].severity, 'medium');
  assert.equal(report.score, 95);
});

test('registered path missing on both sides never turns Critical', () => {
  const report = compareConfigs('{"a": 1}', '{"a": 2}', [['gone', 'deep']]);
  assert.equal(report.diffs[0].severity, 'medium');
});

test('registered root path makes any drift Critical', () => {
  const report = compareConfigs('{"a": 1}', '{"a": 2}', [[]]);
  assert.equal(report.diffs[0].severity, 'critical');
});

test('registered descendant of an unchanged subtree stays quiet', () => {
  const report = compareConfigs(
    '{"svc": {"a": 1, "b": 2}}',
    '{"svc": {"a": 1, "b": 3}}',
    [['svc', 'a']],
  );
  assert.equal(report.diffs.length, 1);
  assert.equal(report.diffs[0].severity, 'medium');
});

test('score penalties: critical 15, medium 5, low 2, floor 0', () => {
  const report = compareConfigs(
    '{"c": 1, "m": 1, "l": 1}',
    '{"c": 2, "m": 2, "l": 1, "new": 0}',
    [['c']],
  );
  assert.deepEqual(report.counts, { critical: 1, medium: 1, low: 1 });
  assert.equal(report.score, 100 - 15 - 5 - 2);

  const flooded = compareConfigs('{}', '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7}', []);
  assert.equal(flooded.counts.low, 7);
  assert.equal(flooded.score, 100 - 14);

  const bottomed = compareConfigs(
    '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8}',
    '{"a":9,"b":9,"c":9,"d":9,"e":9,"f":9,"g":9,"h":9}',
    [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h']],
  );
  assert.equal(bottomed.counts.critical, 8);
  assert.equal(bottomed.score, 0);
});
