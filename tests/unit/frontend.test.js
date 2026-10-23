// Unit tests for the lexer and parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/index.js';
import { lex } from '../../src/lexer.js';
import { parsePHP } from '../../src/parser.js';
import { ParseErr } from '../../src/values.js';

const tokens = (src) => lex(src, 't.php').filter((t) => t.t !== 'eof').map((t) => [t.t, t.v]);

test('lexer: variables, operators and numbers', () => {
  assert.deepEqual(tokens('<?php $a = 1 + 2.5;'), [['var', 'a'], ['op', '='], ['int', 1], ['op', '+'], ['float', 2.5], ['op', ';']]);
});

test('lexer: integer literal forms', () => {
  const v = (s) => tokens(`<?php ${s};`)[0][1];
  assert.equal(v('0x1A'), 26);
  assert.equal(v('0b11'), 3);
  assert.equal(v('017'), 15);
  assert.equal(v('0o17'), 15);
  assert.equal(v('1_000_000'), 1000000);
  assert.equal(v('9223372036854775807'), 9223372036854775807n);
});

test('lexer: integer literals beyond int64 become floats', () => {
  const [t] = tokens('<?php 9223372036854775808;');
  assert.equal(t[0], 'float');
});

test('lexer: line numbers', () => {
  const toks = lex('<?php\n$a\n=\n1;', 't.php');
  assert.deepEqual(toks.slice(0, 3).map((t) => t.l), [2, 3, 4]);
});

test('lexer: inline HTML around PHP blocks', () => {
  const toks = tokens('<h1><?php echo 1; ?></h1>');
  assert.equal(toks[0][0], 'html');
  assert.equal(toks[0][1], '<h1>');
  assert.equal(toks.at(-1)[1], '</h1>');
});

test('parser: multiplication binds tighter than addition', () => {
  const [stmt] = parsePHP('<?php 1 + 2 * 3;', 't.php');
  assert.equal(stmt.e.op, '+');
  assert.equal(stmt.e.b.op, '*');
});

test('parser: ** is right-associative', () => {
  const [stmt] = parsePHP('<?php 2 ** 3 ** 2;', 't.php');
  assert.equal(stmt.e.op, '**');
  assert.equal(stmt.e.a.v, 2);
  assert.equal(stmt.e.b.op, '**');
});

test('parser: + and - are left-associative', () => {
  const [stmt] = parsePHP('<?php 1 - 2 - 3;', 't.php');
  assert.equal(stmt.e.a.op, '-');
  assert.equal(stmt.e.b.v, 3);
});

test('parser: syntax errors report the line', () => {
  assert.throws(() => parsePHP('<?php\n\n$a = ;', 't.php'), (e) => e instanceof ParseErr && e.line === 3);
});

test('parser: empty loop bodies', () => {
  const [stmt] = parsePHP('<?php for ($i = 0; $i < 3; $i++);', 't.php');
  assert.equal(stmt.k, 'For');
});
