<?php
function counter($start, $end, $step = 1) { for ($i = $start; $i <= $end; $i += $step) yield $i; }
foreach (counter(1, 10, 3) as $k => $v) echo "$k:$v "; echo "\n";
function kv() { yield 'a' => 1; yield 'b' => 2; yield 3; }
foreach (kv() as $k => $v) echo "$k=$v "; echo "\n";
function fibg() { [$a, $b] = [0, 1]; while (true) { yield $a; [$a, $b] = [$b, $a + $b]; } }
foreach (fibg() as $i => $f) { if ($i >= 10) break; echo $f, " "; } echo "\n";
function echoer() { while (true) { $v = yield; if ($v === null) return "done"; echo "recv: $v\n"; } }
$g = echoer(); $g->current(); $g->send("hello"); $g->send("world"); $g->send(null); echo $g->getReturn(), "\n";
function inner() { yield 1; yield 2; return 3; }
function outer() { $r = yield from inner(); yield $r; yield from [10, 20]; yield from new ArrayIterator(['x' => 'y']); }
foreach (outer() as $k => $v) echo "$k=>$v "; echo "\n";
function lazyMap(callable $f, iterable $it) { foreach ($it as $k => $v) yield $k => $f($v); }
function lazyFilter(callable $f, iterable $it) { foreach ($it as $k => $v) if ($f($v)) yield $k => $v; }
echo implode(",", iterator_to_array(lazyMap(fn($x) => $x * $x, lazyFilter(fn($x) => $x % 2, range(1, 10))), false)), "\n";
$gen = (function() { $received = []; while (count($received) < 3) { $received[] = yield count($received); } return $received; })();
foreach (range(1, 3) as $i) { $gen->send("v$i"); } var_dump($gen->valid()); print_r($gen->getReturn());
function genWithKeys() { yield 5 => 'a'; yield 'b'; yield 2 => 'c'; yield 'd'; }
foreach (genWithKeys() as $k => $v) echo "$k:$v "; echo "\n";
$g2 = counter(1, 3); echo $g2->current(); $g2->next(); echo $g2->current(); $g2->next(); echo $g2->current(); $g2->next(); var_dump($g2->valid(), $g2->current());
function thrower() { try { yield 1; } catch (Exception $e) { echo "caught in gen: ", $e->getMessage(), "\n"; yield 99; } }
$t = thrower(); $t->current(); echo $t->throw(new Exception("injected")), "\n";
function genRef() { $data = [1, 2, 3]; foreach ($data as $k => $v) { $cmd = yield $v; if ($cmd === 'stop') return; } }
$gr = genRef(); foreach ($gr as $v) { echo $v; if ($v == 2) $gr->send('stop'); } echo "\n";
echo implode(' ', iterator_to_array(counter(1, 5))), "\n";
function nestedYield() { $x = yield 1; $y = yield $x + 10; return $x + $y; }
$n = nestedYield(); echo $n->current(), " "; echo $n->send(5), " "; $n->send(7); echo $n->getReturn(), "\n";
$gen3 = (fn() => yield 42)(); echo $gen3->current(), "\n";
function infinite() { $i = 0; while (true) yield $i++; }
foreach (infinite() as $v) { if ($v > 5) break; echo $v; } echo "\n";
function readLines() { $lines = ["a", "b", "c"]; foreach ($lines as $l) { yield strtoupper($l); } }
echo implode("", iterator_to_array(readLines())), "\n";
var_dump(counter(1,2) instanceof Traversable, counter(1,2) instanceof Iterator, iterator_count(counter(1, 100)));
function genMatch($x) { $r = match(true) { $x > 0 => yield 'pos', default => yield 'neg' }; return $r; }
foreach (genMatch(1) as $v) echo $v, "\n";
function ternGen($c) { echo ($c ? yield 'yes' : 'no'), "\n"; }
foreach (ternGen(true) as $v) echo "got $v\n";
