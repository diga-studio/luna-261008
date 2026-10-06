import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/index.ts';

test('smoke: sqlite and ledger skeleton load', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (a INTEGER)');
  db.close();
  const ledger = new Ledger(':memory:');
  assert.ok(ledger);
  ledger.close();
});
