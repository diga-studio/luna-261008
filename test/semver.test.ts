import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePrecedence, parseSemVer } from '../src/semver';

test('parses valid semver including prerelease and build metadata', () => {
  const v = parseSemVer('1.2.3-alpha.1+build.5');
  assert.equal(v.major, 1);
  assert.equal(v.minor, 2);
  assert.equal(v.patch, 3);
  assert.deepEqual(v.prerelease, ['alpha', '1']);
  assert.equal(v.build, 'build.5');
});

test('rejects invalid semver strings', () => {
  const invalid = [
    '',
    '1.0',
    '1.0.0.0',
    '01.0.0',
    '1.0.0-',
    '1.0.0+',
    '1.0.0-alpha..1',
    '1.0.0-01',
    '1.0.0-a_b',
    'v1.0.0',
    '1.0.0+a+b',
  ];
  for (const s of invalid) {
    assert.throws(() => parseSemVer(s), `should reject: ${JSON.stringify(s)}`);
  }
});

test('precedence follows semver.org ordering rules', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
  ].map(parseSemVer);
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      const cmp = comparePrecedence(ordered[i], ordered[j]);
      assert.equal(Math.sign(cmp), Math.sign(i - j), `${i} vs ${j}`);
    }
  }
});

test('numeric identifiers compare numerically, not lexicographically', () => {
  assert.ok(comparePrecedence(parseSemVer('1.9.0'), parseSemVer('1.10.0')) < 0);
  assert.ok(comparePrecedence(parseSemVer('1.0.0-9'), parseSemVer('1.0.0-10')) < 0);
});

test('build metadata is ignored for precedence', () => {
  assert.equal(comparePrecedence(parseSemVer('1.0.0+aaa'), parseSemVer('1.0.0+bbb')), 0);
  assert.equal(comparePrecedence(parseSemVer('1.0.0+1'), parseSemVer('1.0.0')), 0);
});
