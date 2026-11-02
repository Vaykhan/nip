<?php
// Fibers: suspend/resume through nested function and method calls, throw(), getReturn(),
// errors, and finally blocks of unfinished fibers running when the fiber is destroyed.
$fiber = new Fiber(function (string $x): string {
    echo "start $x\n";
    $y = Fiber::suspend('first');
    echo "resumed with $y\n";
    $z = helper($y);
    return "done $z";
});
function helper($v) {
    $w = Fiber::suspend("from helper $v");
    return strtoupper($w);
}
$v = $fiber->start('A');
echo "suspended: $v\n";
$v = $fiber->resume('B');
echo "suspended: $v\n";
var_dump($fiber->isSuspended(), $fiber->isTerminated());
$v = $fiber->resume('c');
var_dump($v, $fiber->getReturn(), $fiber->isTerminated());
try { $fiber->resume(); } catch (FiberError $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { Fiber::suspend(); } catch (FiberError $e) { echo $e->getMessage(), "\n"; }
$f2 = new Fiber(function () { try { Fiber::suspend(1); } catch (Exception $e) { echo "caught ", $e->getMessage(), "\n"; return 5; } });
$f2->start(); $f2->throw(new Exception('boom')); var_dump($f2->getReturn());
// generator-style producer/consumer
$gen = new Fiber(function () { foreach ([1, 2, 3] as $i) Fiber::suspend($i * 10); });
$out = [$gen->start()]; while (!$gen->isTerminated()) { $x = $gen->resume(); if ($x !== null) $out[] = $x; }
echo implode(',', $out), "\n";
class Task { public function run() { return $this->step() . '!'; } private function step() { return Fiber::suspend('in method') ?? 'none'; } }
$t = new Fiber([new Task, 'run']); echo $t->start(), "\n"; $t->resume('ok'); echo $t->getReturn(), "\n";
$unfinished = new Fiber(function () { try { Fiber::suspend(); } finally { echo "finally of unfinished fiber\n"; } });
$unfinished->start();
unset($unfinished);
// a scheduler running several fibers round-robin
$log = [];
$tasks = [];
foreach (['a', 'b'] as $name) {
    $tasks[] = new Fiber(function () use ($name, &$log) { for ($i = 1; $i <= 3; $i++) { $log[] = "$name$i"; Fiber::suspend(); } });
}
foreach ($tasks as $t) $t->start();
while (array_filter($tasks, fn($t) => !$t->isTerminated())) foreach ($tasks as $t) if ($t->isSuspended()) $t->resume();
echo implode(' ', $log), "\n";
echo "end\n";
