import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { compareConfigs, key } from '../src/index';

test('permission id drift is Critical, equivalent respelling is invisible', () => {
  const baseline = '{"perm": 9007199254740992, "limit": 100}';
  const current = '{"perm": 9007199254740993, "limit": 10e1}';
  const report = compareConfigs(baseline, current, [[key('perm')]]);
  equal(report.entries.length, 1);
  const only = report.entries[0];
  equal(only.kind, 'modified');
  equal(only.severity, 'critical');
  deepEqual(only.path, [key('perm')]);
  deepEqual(only.baseline, { type: 'number', raw: '9007199254740992' });
  deepEqual(only.current, { type: 'number', raw: '9007199254740993' });
  deepEqual(report.counts, { critical: 1, medium: 0, low: 0 });
  equal(report.score, 85);
});

test('score is independent of key order and number spelling', () => {
  const a = compareConfigs(
    '{"perm": 9007199254740992, "limit": 100}',
    '{"perm": 9007199254740993, "limit": 100.0}',
    [[key('perm')]],
  );
  const b = compareConfigs(
    '{ "limit": 1e2, "perm": 9007199254740992 }',
    '{ "perm": 9007199254740993.0, "limit": 100 }',
    [[key('perm')]],
  );
  equal(a.score, b.score);
  equal(a.entries.length, b.entries.length);
  equal(a.score, 85);
});

test('score floors at zero and mixes severities', () => {
  const baseline = '{"a":1,"b":2,"c":3,"d":4}';
  const current = '{"a":10,"b":20,"c":30}';
  const report = compareConfigs(baseline, current, [[key('a')], [key('b')]]);
  // a,b modified+critical (2*15), c modified+medium (5), d removed+low (2) => 63
  deepEqual(report.counts, { critical: 2, medium: 1, low: 1 });
  equal(report.score, 100 - 30 - 5 - 2);
  const many = compareConfigs('{}', '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10,"k":11,"l":12,"m":13,"n":14,"o":15,"p":16,"q":17,"r":18,"s":19,"t":20,"u":21,"v":22,"w":23,"x":24,"y":25,"z":26,"a1":27,"a2":28,"a3":29,"a4":30,"a5":31,"a6":32,"a7":33,"a8":34,"a9":35,"b1":36,"b2":37,"b3":38,"b4":39,"b5":40,"b6":41,"b7":42,"b8":43,"b9":44,"c1":45,"c2":46,"c3":47,"c4":48,"c5":49,"c6":50,"c7":51}');
  equal(many.score, 0);
});
