import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';

test('database opens and migrates', () => {
  const db = openDatabase(':memory:');
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('releases'));
  assert.ok(names.includes('bugs'));
  assert.ok(names.includes('tests'));
  db.close();
});
