<?php
function fib($n) { return $n < 2 ? $n : fib($n - 1) + fib($n - 2); }
$t = microtime(true); echo fib(27), "\n";
