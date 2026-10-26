// Compile-time errors (src/compiler/checks.js): PHP reports these for the whole file before
// running any of it, including code inside functions that are never called.
// Messages were taken from PHP 8.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/index.js';

const CASES = [
  ['interface A {} interface B {} function t(): (A&B)|A {}', 'Type A&B is redundant as it is more restrictive than type A'],
  ['interface A {} interface B {} interface C {} function t(): (A&B)|(A&B&C) {}', 'Type A&B&C is redundant as it is more restrictive than type A&B'],
  ['interface A {} interface B {} function t(): object|(A&B) {}', 'Type (A&B)|object contains both object and a class type, which is redundant'],
  ['class T { function f(): static|object {} }', 'Type static|object contains both object and a class type, which is redundant'],
  ['function t(): iterable|iterable {}', 'Duplicate type array is redundant'],
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
  ['(new stdClass)->a = 1;', 'Cannot use temporary expression in write context'],
  ['echo 1; function f() { unset([1][0]); }', 'Cannot use temporary expression in write context'],
  ['foreach ([1] as FOO[0]);', 'Cannot use temporary expression in write context'],
  ['[(clone $x)->a] = [1];', 'Assignments can only happen to writable values'],
  ['class A { public $p = $x; }', 'Constant expression contains invalid operations'],
  ['class A { const X = new stdClass; }', 'New expressions are not supported in this context'],
  ['function f($a = static::X) {}', '"static::" is not allowed in compile-time constants'],
  ['function f($a = new class {}) {}', 'Cannot use anonymous class in constant expression'],
  ['#[A(...[1])] function f() {}', 'Cannot use unpacking in attribute argument list'],
  // inheritance (checked when the class is linked, before the script runs when it's early bound)
  ['echo 1; class A { function f(int $a) {} } class B extends A { function f(string $a) {} }', 'Declaration of B::f(string $a) must be compatible with A::f(int $a)'],
  ['class A { function f($a, $b = [1], ...$c) {} } class B extends A { function f($a) {} }', 'Declaration of B::f($a) must be compatible with A::f($a, $b = [...], ...$c)'],
  ['class A { function f(): static {} } class B extends A { function f(): B {} }', 'Declaration of B::f(): B must be compatible with A::f(): static'],
  ['class A { function f() {} } class B extends A { static function f() {} }', 'Cannot make non static method A::f() static in class B'],
  ['class A { function f() {} } abstract class B extends A { abstract function f(); }', 'Cannot make non abstract method A::f() abstract in class B'],
  ['class A { protected function f() {} } class B extends A { private function f() {} }', 'Access level to B::f() must be protected (as in class A) or weaker'],
  ['class B implements Countable { function count(string $x): int {} }', 'Declaration of B::count(string $x): int must be compatible with Countable::count(): int'],
  // write contexts
  ['function f(&$r) {} f((new stdClass)->a);', 'Cannot use temporary expression in write context'],
  ['function f($v) {} f($a[]);', 'Cannot use [] for reading'],
  ['function f() {} f() = 1;', "Can't use function return value in write context"],
  ['$o->m()++;', "Can't use method return value in write context"],
  ['strlen("x")[0] = 1;', 'Cannot use result of built-in function in write context'],
  ['f(a: 1, ...$b);', 'Cannot use argument unpacking after named arguments'],
  ['for (;;) { break 2; }', "Cannot 'break' 2 levels"],
  ['class A extends static {}', "Cannot use 'static' as class name, as it is reserved"],
  ['enum E { case A; public static function cases(): array {} }', 'Cannot redeclare E::cases()'],
  ['class A { function __get(int $n) {} }', 'A::__get(): Parameter #1 ($n) must be of type string when declared'],
  ['function f(): int { yield 1; }', 'Generator return type must be a supertype of Generator, int given'],
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
  'class A { function f(int $a): iterable {} } class B extends A { function f(int|string $a = 1, ...$more): array {} }',
  'class A { function f(): self {} function g(): ?A {} } class B extends A { function f(): static {} function g(): never {} }',
  'class A { private function f(int $a) {} function __construct(int $a) {} } class B extends A { function f(string $a) {} function __construct(string $a) {} }',
  'const C = new stdClass; class A { const X = [1, 2][0] + PHP_INT_SIZE; public $p = self::X ?? -1; } function f($a = new A(x: 1), $b = __LINE__) {} #[Attr(new A, [1])] function g() {}',
  // f() is declared after the call: whether it takes a reference is only known at run time
  'function g() { return new stdClass; } f((new stdClass)->a); g()->a = 1; g()->b[] = 2; isset((new stdClass)->c); function f(&$r) {}',
  'class B implements IteratorAggregate { #[\\ReturnTypeWillChange] function getIterator() {} }',
];
for (const code of VALID) {
  test(`compiles: ${code}`, () => {
    assert.deepEqual(run(`<?php ${code}`, { ini: { display_errors: '1' } }), { output: '', exitCode: 0 });
  });
}
