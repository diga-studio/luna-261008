import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillPulseEngine } from '../src/index.js';

test('skeleton: engine constructs', () => {
  const engine = new SkillPulseEngine();
  assert.ok(engine);
});
