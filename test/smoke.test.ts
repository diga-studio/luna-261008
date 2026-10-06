import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/index.js';

test('smoke', () => {
  assert.equal(typeof createStats, 'function');
});
