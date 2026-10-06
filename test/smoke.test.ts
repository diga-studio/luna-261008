import test from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/index.js';

test('library can be constructed and closed', () => {
  const lib = new ShelfSync(':memory:');
  lib.close();
});
