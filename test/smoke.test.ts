import assert from 'node:assert/strict';
import { test } from './harness';
import { LeadPulse } from '../src/index';

test('skeleton compiles and exports LeadPulse', () => {
  assert.equal(typeof LeadPulse, 'function');
});
