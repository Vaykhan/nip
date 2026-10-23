<?php
function add(int $a, int $b = 10): int { return $a + $b; }
echo add(1), " ", add(1, 2), " ", add(b: 5, a: 1), "\n";
function variadic(...$nums) { return array_sum($nums); }
echo variadic(1, 2, 3), " ", variadic(...[4, 5]), "\n";
function byRef(&$x) { $x++; } $v = 1; byRef($v); echo $v, "\n";
function &getRef(array &$arr) { return $arr[0]; }
$counter = function() { static $n = 0; return ++$n; }; $counter(); $counter(); echo $counter(), "\n";
function staticCounter() { static $c = 0; $c++; return $c; } staticCounter(); echo staticCounter(), "\n";
$mult = 3; $fn = function($x) use ($mult) { return $x * $mult; }; echo $fn(5), "\n";
$total = 0; $acc = function($x) use (&$total) { $total += $x; }; $acc(5); $acc(6); echo $total, "\n";
$arrow = fn($x) => $x * $mult; echo $arrow(4), "\n";
$nested = fn($x) => fn($y) => $x + $y + $mult; echo $nested(1)(2), "\n";
function gen_compose(callable ...$fns) { return function($x) use ($fns) { foreach ($fns as $f) $x = $f($x); return $x; }; }
echo gen_compose('strtoupper', 'strrev', fn($s) => "[$s]")("abc"), "\n";
echo call_user_func('str_repeat', 'ab', 2), " ", call_user_func_array([new ArrayObject([1,2,3]), 'count'], []), " ", call_user_func_array('add', ['a' => 2, 'b' => 3]), "\n";
$strlen = strlen(...); echo $strlen("hello"), "\n";
class M { public function hi($n) { return "hi $n"; } public static function st($n) { return "st $n"; } }
$m = new M; $h = $m->hi(...); echo $h("x"), " ", (M::st(...))("y"), " ", call_user_func([$m, 'hi'], 'z'), " ", call_user_func('M::st', 'w'), " ", call_user_func([M::class, 'st'], 'v'), "\n";
function defaults($a, $b = [1, 2], $c = null, $d = PHP_INT_MAX, $e = M::class) { return json_encode(func_get_args()); }
echo defaults(1), " ", defaults(1, 2, 3), "\n";
function nullable(?string $s = null): ?string { return $s; } var_dump(nullable(), nullable("x"));
function union(int|string $v): string { return gettype($v); } echo union(1), union("a"), "\n";
function typed(float $f) { var_dump($f); } typed(5); typed("3.5");
function strictReturn(): int { return "42"; } var_dump(strictReturn());
try { add("x"); } catch (TypeError $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { add(); } catch (ArgumentCountError $e) { echo $e->getMessage(), "\n"; }
function recurse($n) { return $n <= 0 ? 0 : $n + recurse($n - 1); } echo recurse(5000), "\n";
$fact = function($n) use (&$fact) { return $n <= 1 ? 1 : $n * $fact($n - 1); }; echo $fact(20), "\n";
echo (function() { return func_num_args(); })(1, 2, 3), "\n";
function named(int $x, string ...$rest) { return $x . ':' . implode(',', $rest) . ':' . json_encode($rest); } echo named(1, 'a', 'b'), "\n";
function kw(...$args) { return json_encode($args); } echo kw(1, 2, a: 3, b: 4), "\n";
var_dump(function_exists('add'), function_exists('nope'), is_callable('strlen'), is_callable([new M, 'hi']), is_callable('M::st'));
$compose = array_reduce([fn($x) => $x + 1, fn($x) => $x * 2], fn($carry, $f) => fn($x) => $f($carry($x)), fn($x) => $x);
echo $compose(5), "\n";
function gen_id() { static $id = 100; return $id++; } echo gen_id(), gen_id(), "\n";
$arr = [3, 1, 2]; usort($arr, function($a, $b) { return $a > $b; }); print_r($arr);
echo implode(",", array_map(fn($p) => $p ** 2, range(1, 5))), "\n";
$obj = new class { public $v = 42; public function getClosure() { return function() { return $this->v; }; } };
$cl = $obj->getClosure(); echo $cl(), "\n";
class Bindable { private $secret = 's3cret'; }
$peek = function() { return $this->secret; }; echo Closure::bind($peek, new Bindable, Bindable::class)(), " ", $peek->call(new Bindable), "\n";
$unbound = fn() => 42; echo $unbound->bindTo(null)(), "\n";
function refArr(array &$a) { $a[] = 4; } $ra = [1]; refArr($ra); echo count($ra), "\n";
function modify($arr) { $arr[] = 99; return $arr; } $orig = [1]; $new = modify($orig); echo count($orig), count($new), "\n";
$fnArr = ['strtoupper', 'ucfirst']; foreach ($fnArr as $f) echo $f('abc'), " "; echo "\n";
echo (new ReflectionFunctionFake ?? null) ? '' : '', "\n";
class ReflectionFunctionFake {}
