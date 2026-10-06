import test from 'node:test';
import assert from 'node:assert/strict';
import { OkrHealthEngine } from '../src/index.js';

test('skeleton: engine module is importable', () => {
  assert.equal(typeof OkrHealthEngine, 'function');
});
