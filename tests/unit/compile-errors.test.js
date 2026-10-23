// Compile-time errors (src/compiler/checks.js): PHP reports these for the whole file before
// running any of it, including code inside functions that are never called.
// Messages were taken from PHP 8.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/index.js';

const CASES = [
  ['$a = []; echo $a[];', 'Cannot use [] for reading'],
  ['$a = []; unset($a[]);', 'Cannot use [] for unsetting'],
  ['$a = []; isset($a[]);', 'Cannot use [] for reading'],
  ['$a = []; strlen($a[]);', 'Cannot use [] for reading'],
  ['function g() { $GLOBALS[] = 1; }', 'Cannot append to $GLOBALS'],
  ['echo "out"; function h() { $a = []; echo $a[]; }', 'Cannot use [] for reading'],
  ['[] = [1];', 'Cannot use empty list'],
  ['[[]] = [[1]];', 'Cannot use empty list'],
  ['[...$a] = [1];', 'Spread operator is not supported in assignments'],
  ['[1 => $a, $b] = [1];', 'Cannot mix keyed and unkeyed array entries in assignments'],
  ['goto nope;', "'goto' to undefined label 'nope'"],
  ['a: a: ;', "Label 'a' already defined"],
  ['function f() { goto a; } a: echo 1;', "'goto' to undefined label 'a'"],
  ['goto a; while (0) { a: }', "'goto' into loop or switch statement is disallowed"],
  ['goto a; switch (1) { case 1: a: }', "'goto' into loop or switch statement is disallowed"],
  ['goto a; foreach ([1] as $v) { a: }', "'goto' into loop or switch statement is disallowed"],
  ['goto a; try { } finally { a: }', 'jump into a finally block is disallowed'],
  ['try { } finally { goto a; } a: ;', 'jump out of a finally block is disallowed'],
  ['function f(self $x) {}', 'Cannot use "self" when no class scope is active'],
  ['function f(): static {}', 'Cannot use "static" when no class scope is active'],
  ['echo 1; function f() { return new self; }', 'Cannot use "self" when no class scope is active'],
  ['class A { function m(parent $x) {} }', 'Cannot use "parent" when current class scope has no parent'],
  ['class P { function m() {} } class C extends P { #[\\Override] function n() {} }', 'C::n() has #[\\Override] attribute, but no matching parent method exists'],
  ['#[Attribute] function f() {}', 'Attribute "Attribute" cannot target function (allowed targets: class)'],
  ['#[Attribute] #[Attribute] class A {}', 'Attribute "Attribute" must not be repeated'],
  ['class C { #[Override] public $p; }', 'Attribute "Override" cannot target property (allowed targets: method)'],
];

for (const [code, msg] of CASES) {
  test(`compile error: ${code}`, () => {
    const r = run(`<?php ${code}`, { file: 'x.php', ini: { display_errors: '1' } });
    assert.equal(r.output, `\nFatal error: ${msg} in x.php on line 1\n`);
    assert.equal(r.exitCode, 255);
  });
}

const VALID = [
  '$a = []; $a[] = 1; $a[][] = 2; $a[] .= "x"; $a[]++;',
  '$a = []; foreach ([1] as $a[]); [$a[]] = [1]; $r = &$a[];',
  'function f(&$x) {} $a = []; f($a[]); sort($a);',
  'goto a; if (0) { a: } goto b; try { b: } catch (Exception $e) {} while (0) { goto c; c: }',
  '$f = function (self $x): static {}; class A { function m() { return fn(self $s) => parent::class ?? 1; } } trait T { function t(parent $p) {} }',
  'class P { function m() {} } class C extends P { #[\\Override] function m() {} } interface I { function i(); } class D implements I { #[\\Override] function i() {} }',
];
for (const code of VALID) {
  test(`compiles: ${code}`, () => {
    assert.deepEqual(run(`<?php ${code}`, { ini: { display_errors: '1' } }), { output: '', exitCode: 0 });
  });
}
