import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numberLiteralsEqual } from '../src/decimal.js';

test('equivalent spellings of the same decimal value', () => {
  assert.equal(numberLiteralsEqual('1', '1.0'), true);
  assert.equal(numberLiteralsEqual('1', '10e-1'), true);
  assert.equal(numberLiteralsEqual('1.50', '1.5'), true);
  assert.equal(numberLiteralsEqual('12300', '123e2'), true);
  assert.equal(numberLiteralsEqual('0.001', '1e-3'), true);
  assert.equal(numberLiteralsEqual('-0', '0'), true);
  assert.equal(numberLiteralsEqual('0.0e5', '-0e-3'), true);
});

test('adjacent integers beyond float precision stay distinct', () => {
  assert.equal(numberLiteralsEqual('9007199254740992', '9007199254740993'), false);
  assert.equal(numberLiteralsEqual('2', '2.0000000000000001'), false);
});

test('huge exponents are compared without expansion', () => {
  assert.equal(numberLiteralsEqual('1e1000000000', '10e999999999'), true);
  assert.equal(numberLiteralsEqual('1e-1000000000', '0.1e-999999999'), true);
  assert.equal(numberLiteralsEqual('1e1000000000', '1e999999999'), false);
});

test('sign matters for nonzero values', () => {
  assert.equal(numberLiteralsEqual('-1.5', '1.5'), false);
});

test('long mantissas compare exactly', () => {
  const a = '1.' + '7'.repeat(4096);
  const b = '1.' + '7'.repeat(4095) + '8';
  assert.equal(numberLiteralsEqual(a, a), true);
  assert.equal(numberLiteralsEqual(a, b), false);
});
