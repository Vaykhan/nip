// Unit tests for the value model: conversions, comparison, arithmetic and arrays.
// Expected values were checked against PHP 8.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/index.js';
import { Flt, mkf, PHPArray } from '../../src/values.js';
import { toBool, toInt, toStr } from '../../src/convert.js';
import { cmp, looseEq, strictEq } from '../../src/compare.js';
import { add, mul, mod, pow } from '../../src/arith.js';

const isFloat = (v, x) => v instanceof Flt && (Number.isNaN(x) ? Number.isNaN(v.v) : v.v === x);

test('toStr: float formatting uses precision=14', () => {
  assert.equal(toStr(mkf(0.1 + 0.2)), '0.3');
  assert.equal(toStr(mkf(1.0)), '1');
  assert.equal(toStr(mkf(1e100)), '1.0E+100');
  assert.equal(toStr(mkf(-0.0)), '-0');
  assert.equal(toStr(true), '1');
  assert.equal(toStr(false), '');
  assert.equal(toStr(null), '');
});

test('toInt: leading-numeric strings', () => {
  assert.equal(toInt('12abc'), 12);
  assert.equal(toInt(' 12'), 12);
  assert.equal(toInt('1e3'), 1000);
  assert.equal(toInt('abc'), 0);
  assert.equal(toInt(mkf(3.99)), 3);
});

test('toBool: falsy values', () => {
  for (const v of [0, '', '0', null, false, mkf(0.0), new PHPArray()]) assert.equal(toBool(v), false);
  for (const v of ['0.0', ' ', 'a', 1, mkf(0.1), PHPArray.from([0])]) assert.equal(toBool(v), true);
});

test('looseEq: PHP 8 number/string comparison', () => {
  assert.equal(looseEq(0, 'a'), false);
  assert.equal(looseEq('1', '01'), true);
  assert.equal(looseEq('10', '1e1'), true);
  assert.equal(looseEq(100, '1e2'), true);
  assert.equal(looseEq('abc', 0), false);
  assert.equal(looseEq(null, false), true);
  assert.equal(looseEq(new PHPArray(), false), true);
  assert.equal(looseEq(mkf(NaN), mkf(NaN)), false);
});

test('strictEq: type and value', () => {
  assert.equal(strictEq('1e3', '1000'), false);
  assert.equal(strictEq(1, mkf(1)), false);
  assert.equal(strictEq(mkf(NaN), mkf(NaN)), false);
  assert.equal(strictEq(PHPArray.from([1, 2]), PHPArray.from([1, 2])), true);
});

test('cmp: spaceship operator', () => {
  assert.equal(cmp(7, '7'), 0);
  assert.equal(cmp('a', 'b'), -1);
  assert.equal(cmp(PHPArray.from([1, 2]), PHPArray.from([1, 3])), -1);
});

test('arithmetic: int overflow turns into float', () => {
  assert.ok(isFloat(add(9223372036854775807n, 1), 9223372036854775808));
  assert.ok(isFloat(mul(9223372036854775807n, 2), 18446744073709551616));
  assert.equal(add(9223372036854775806n, 1), 9223372036854775807n);
  assert.ok(isFloat(pow(2, 63), 9223372036854775808));
  assert.ok(isFloat(pow(2, -1), 0.5));
});

test('arithmetic: numeric strings and modulo sign', () => {
  assert.ok(isFloat(add('5', '5.5'), 10.5));
  assert.equal(add('5', '5'), 10);
  assert.equal(mod(-7, 3), -1);
});

test('PHPArray: append after a negative key (PHP 8.3)', () => {
  const a = new PHPArray();
  a.set(-5, 1);
  a.push(2);
  assert.deepEqual([...a.keys()], [-5, -4]);
});

test('PHPArray: packed list becomes a hash when keys stop being 0..n-1', () => {
  const a = PHPArray.from(['a', 'b', 'c']);
  assert.equal(a.map, null);
  a.delete(1);
  a.set('x', 'y');
  assert.deepEqual([...a.keys()], [0, 2, 'x']);
  assert.equal(a.get(2), 'c');
  assert.equal(a.size, 3);
});
