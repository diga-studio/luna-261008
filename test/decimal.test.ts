import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { normalizeNumber, normalizedEqual } from '../src/decimal';

function eq(a: string, b: string): boolean {
  return normalizedEqual(normalizeNumber(a), normalizeNumber(b));
}

test('equivalent spellings of the same decimal value', () => {
  ok(eq('1', '1.0'));
  ok(eq('1', '10e-1'));
  ok(eq('1', '0.1e1'));
  ok(eq('1.5', '1.50'));
  ok(eq('0.1', '1e-1'));
  ok(eq('100', '1e2'));
  ok(eq('100', '10e1'));
  ok(eq('123', '123.000'));
  ok(eq('-2.5', '-25e-1'));
});

test('negative zero equals zero', () => {
  ok(eq('-0', '0'));
  ok(eq('-0.0', '0e5'));
  ok(eq('0', '0.000'));
});

test('adjacent integers beyond float precision stay distinct', () => {
  ok(!eq('9007199254740992', '9007199254740993'));
  ok(!eq('123456789012345678901234567890', '123456789012345678901234567891'));
  ok(!eq('1', '2'));
  ok(!eq('-1', '1'));
  ok(!eq('1.5', '1.6'));
});

test('huge exponents compare without materializing the value', () => {
  ok(eq('1e1000000000', '10e999999999'));
  ok(eq('1e1000000000', '0.1e1000000001'));
  ok(!eq('1e1000000000', '1e999999999'));
  ok(eq('1e-1000000000', '10e-1000000001'));
});

test('mantissas up to 4096 digits', () => {
  const a = '1' + '2'.repeat(4095);
  const b = '1' + '2'.repeat(4094) + '3';
  ok(eq(a, a + '.0'));
  ok(!eq(a, b));
});

test('normalization strips zeros and tracks the exponent', () => {
  const n = normalizeNumber('-12.3400e2');
  equal(n.sign, -1);
  equal(n.digits, '1234');
  equal(n.exp, 0);
  const z = normalizeNumber('-0.000e7');
  equal(z.sign, 0);
});
