import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSql } from '../src/index.ts';

test('骨架：空输入返回空命中且完整', () => {
  const result = scanSql('');
  assert.deepEqual(result.hits, []);
  assert.equal(result.complete, true);
});
