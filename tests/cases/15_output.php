<?php
ob_start(); echo "captured"; $c = ob_get_clean(); echo strtoupper($c), "\n";
ob_start(); echo "a"; ob_start(); echo "b"; $inner = ob_get_clean(); $outer = ob_get_clean(); echo "$outer|$inner\n";
ob_start(fn($buf) => str_replace("x", "y", $buf)); echo "xxx\n"; ob_end_flush();
echo ob_get_level(), "\n";
ob_start(); print_r([1]); var_dump(1); $s = ob_get_contents(); ob_end_clean(); echo strlen($s), "\n";
printf("%s=%d\n", "n", 5); echo sprintf("%08.3f", -3.14159), "\n"; fprintf(STDOUT, "to stdout %d\n", 1);
$r = print_r(['a' => [1]], true); echo strlen($r), "\n";
echo str_pad(decbin(10), 8, "0", STR_PAD_LEFT), " ", sprintf("%'010.2f|%-8s|%08d", 3.5, "hi", -42), "\n";
var_dump(0.1 + 0.2, 1e100, 2.5e-5, 100.0, -1.0E-10, 1.23456789012345678, (float)PHP_INT_MAX);
echo 0.1 + 0.2, " ", 1/7, " ", 1e22, " ", 123456789.12345678, " ", 0.00001234, " ", round(2.675, 2), " ", 3.0, "\n";
var_dump(round(-0.5), round(1.95583, 2), round(5.045, 2), round(5.055, 2), floor(5), ceil(4.0001), 10/4, 10/5);
echo number_format(2.5), number_format(3.5), " ", number_format(-1234.567, 1), " ", number_format(0.5), " ", number_format(1.005, 2), "\n";
setlocale(LC_ALL, 'C');
echo implode(" ", array_map(fn($x) => sprintf("%.1f", $x), [0.05, 0.15, 0.25, 0.35])), "\n";
echo sprintf("%5.2e", 12345.6789), " ", sprintf("%G", 0.00001), " ", sprintf("%g", 123456789), " ", sprintf("%g", 100000), " ", sprintf("%g", 1000000), "\n";
var_dump((string)0.1, strval(1e6), strval(1e15), (string)1.0E+15, 1e15 . "", 0.1 + 0.7);
