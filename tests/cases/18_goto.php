<?php
// goto: forward and backward jumps, leaving loops and switch, entering if/else, blocks, try
// and catch bodies, finally blocks running on the way out, and gotos inside generators.
echo "begin\n";
goto start;
echo "skipped\n";
start:
echo "start\n";

$i = 0;
loop:
$i++;
if ($i < 3) goto loop;
echo "looped to $i\n";

for ($a = 0; $a < 3; $a++) {
    for ($b = 0; $b < 3; $b++) {
        if ($a * $b === 2) goto found;
    }
}
found:
echo "found $a,$b\n";

goto inIf;
if (false) {
    echo "not here\n";
    inIf:
    echo "inside if\n";
} else {
    echo "not in else\n";
}

if (true) { goto inElse; } else { inElse: echo "inside else\n"; }

goto inTry;
try {
    echo "not here\n";
    inTry:
    echo "inside try\n";
    throw new RuntimeException('boom');
} catch (RuntimeException $e) {
    echo "caught ", $e->getMessage(), "\n";
}

goto inCatch;
try {
} catch (Exception $e) {
    inCatch:
    echo "inside catch, \$e is ", isset($e) ? 'set' : 'unset', "\n";
} finally {
    echo "finally after catch\n";
}

try {
    goto out;
} finally {
    echo "finally on the way out\n";
}
out:

switch (2) {
    case 1:
        echo "one\n";
    case 2:
        goto second;
        first:
        echo "first label\n";
        break;
        second:
        echo "second label\n";
        goto first;
}

function sumDown(int $n): int {
    $total = 0;
    again:
    if ($n > 0) { $total += $n; $n--; goto again; }
    return $total;
}
echo "sum ", sumDown(4), "\n";

function gen() {
    $n = 0;
    top:
    yield $n;
    if (++$n < 3) goto top;
    try { goto done; } finally { yield 'fin'; }
    done:
    yield 'done';
}
echo implode(',', iterator_to_array(gen(), false)), "\n";

$f = function () { goto x; echo "no"; x: return "closure label"; };
echo $f(), "\n";
