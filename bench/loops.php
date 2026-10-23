<?php
$a = [];
for ($i = 0; $i < 300000; $i++) { $a[] = $i * 2; }
$sum = 0; foreach ($a as $v) { $sum += $v; }
$s = ''; for ($i = 0; $i < 100000; $i++) { $s .= chr(65 + $i % 26); }
$m = []; for ($i = 0; $i < 100000; $i++) { $m["k" . ($i % 1000)] = ($m["k" . ($i % 1000)] ?? 0) + 1; }
usort($a, fn($x, $y) => $y <=> $x);
echo $sum, " ", strlen($s), " ", count($m), " ", $a[0], "\n";
class P { public $x; function __construct($x) { $this->x = $x; } function get() { return $this->x; } }
$t = 0; for ($i = 0; $i < 200000; $i++) { $o = new P($i); $t += $o->get(); } echo $t, "\n";
$str = str_repeat("hello world ", 10000); echo count(explode(" ", $str)), " ", strlen(str_replace("world", "there", $str)), " ", preg_match_all('/o/', $str), "\n";
