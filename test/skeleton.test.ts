import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShelfSync } from '../src/shelfsync.js';

test('skeleton: 可打开并关闭内存数据库', () => {
  const lib = new ShelfSync(':memory:');
  lib.close();
  assert.ok(true);
});
