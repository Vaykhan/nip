<?php
// binary trees
function bottomUpTree($depth) { if (!$depth) return [null, null]; $depth--; return [bottomUpTree($depth), bottomUpTree($depth)]; }
function itemCheck($t) { return 1 + ($t[0] === null ? 0 : itemCheck($t[0]) + itemCheck($t[1])); }
$maxDepth = 8; $stretch = bottomUpTree($maxDepth + 1); printf("stretch tree of depth %d\t check: %d\n", $maxDepth + 1, itemCheck($stretch));
$long = bottomUpTree($maxDepth);
for ($d = 4; $d <= $maxDepth; $d += 2) { $it = 1 << ($maxDepth - $d + 4); $check = 0; for ($i = 0; $i < $it; $i++) $check += itemCheck(bottomUpTree($d)); printf("%d\t trees of depth %d\t check: %d\n", $it, $d, $check); }
printf("long lived tree of depth %d\t check: %d\n", $maxDepth, itemCheck($long));
// fannkuch
function fannkuch($n) {
  $p = range(0, $n - 1); $q = $p; $s = $p; $sign = 1; $maxflips = 0; $sum = 0;
  while (true) {
    $q0 = $p[0];
    if ($q0 != 0) {
      for ($i = 1; $i < $n; $i++) $q[$i] = $p[$i];
      $flips = 1;
      while (true) { $qq = $q[$q0]; if ($qq == 0) { $sum += $sign * $flips; if ($flips > $maxflips) $maxflips = $flips; break; } $q[$q0] = $q0; if ($q0 >= 3) { $i = 1; $j = $q0 - 1; do { $t = $q[$i]; $q[$i] = $q[$j]; $q[$j] = $t; $i++; $j--; } while ($i < $j); } $q0 = $qq; $flips++; }
    }
    if ($sign == 1) { $t = $p[1]; $p[1] = $p[0]; $p[0] = $t; $sign = -1; }
    else { $t = $p[1]; $p[1] = $p[2]; $p[2] = $t; $sign = 1;
      for ($i = 2; $i < $n; $i++) { $sx = $s[$i]; if ($sx != 0) { $s[$i] = $sx - 1; break; } if ($i == $n - 1) return [$sum, $maxflips]; $s[$i] = $i; $t = $p[0]; for ($j = 0; $j <= $i; $j++) { $p[$j] = $p[$j + 1]; } $p[$i + 1] = $t; } }
  }
}
[$checksum, $flips] = fannkuch(7); echo "$checksum\nPfannkuchen(7) = $flips\n";
// spectral norm
function A($i, $j) { return 1.0 / ((($i + $j) * ($i + $j + 1) >> 1) + $i + 1); }
function Av($n, $v) { $Av = []; for ($i = 0; $i < $n; ++$i) { $sum = 0.0; foreach ($v as $j => $v_j) $sum += A($i, $j) * $v_j; $Av[$i] = $sum; } return $Av; }
function Atv($n, $v) { $Atv = []; for ($i = 0; $i < $n; ++$i) { $sum = 0.0; foreach ($v as $j => $v_j) $sum += A($j, $i) * $v_j; $Atv[$i] = $sum; } return $Atv; }
function AtAv($n, $v) { return Atv($n, Av($n, $v)); }
$n = 50; $u = array_fill(0, $n, 1.0);
for ($i = 0; $i < 10; $i++) { $v = AtAv($n, $u); $u = AtAv($n, $v); }
$vBv = 0.0; $vv = 0.0; foreach ($v as $i => $vi) { $vBv += $u[$i] * $vi; $vv += $vi * $vi; } printf("%0.9f\n", sqrt($vBv / $vv));
// nbody (short)
function energy(&$b) { $e = 0.0; $n = count($b); for ($i = 0; $i < $n; $i++) { $bi = $b[$i]; $e += 0.5 * $bi[6] * ($bi[3]*$bi[3] + $bi[4]*$bi[4] + $bi[5]*$bi[5]); for ($j = $i + 1; $j < $n; $j++) { $bj = $b[$j]; $dx = $bi[0] - $bj[0]; $dy = $bi[1] - $bj[1]; $dz = $bi[2] - $bj[2]; $e -= ($bi[6] * $bj[6]) / sqrt($dx*$dx + $dy*$dy + $dz*$dz); } } return $e; }
$pi = 3.141592653589793; $solarMass = 4 * $pi * $pi; $daysPerYear = 365.24;
$bodies = [[0,0,0,0,0,0,$solarMass], [4.84143144246472090e+00,-1.16032004402742839e+00,-1.03622044471123109e-01,1.66007664274403694e-03*$daysPerYear,7.69901118419740425e-03*$daysPerYear,-6.90460016972063023e-05*$daysPerYear,9.54791938424326609e-04*$solarMass]];
printf("%0.9f\n", energy($bodies));
// mandelbrot ascii
for ($y = -1.2; $y <= 1.2; $y += 0.2) { $line = ''; for ($x = -2.0; $x <= 0.6; $x += 0.08) { $zr = $zi = 0; $k = 0; while ($k < 50 && $zr*$zr + $zi*$zi < 4) { $t = $zr*$zr - $zi*$zi + $x; $zi = 2*$zr*$zi + $y; $zr = $t; $k++; } $line .= $k == 50 ? '#' : ($k > 10 ? '+' : '.'); } echo $line, "\n"; }
// sieve
function sieve($n) { $is = array_fill(0, $n + 1, true); $is[0] = $is[1] = false; for ($i = 2; $i * $i <= $n; $i++) if ($is[$i]) for ($j = $i * $i; $j <= $n; $j += $i) $is[$j] = false; return array_keys(array_filter($is)); }
$pr = sieve(1000); echo count($pr), " ", array_sum($pr), " ", end($pr), "\n";
// word frequency
$text = "the quick brown fox jumps over the lazy dog the fox"; $freq = array_count_values(str_word_count(strtolower($text), 1)); arsort($freq); print_r(array_slice($freq, 0, 3, true));
// string manipulation: caesar, palindromes, anagram groups
function caesar($s, $k) { return preg_replace_callback('/[a-z]/i', function($m) use ($k) { $c = $m[0]; $b = ctype_upper($c) ? 65 : 97; return chr((ord($c) - $b + $k) % 26 + $b); }, $s); }
echo caesar("Hello, World!", 3), " ", caesar(caesar("Hello, World!", 3), 23), "\n";
$words = ['listen', 'silent', 'enlist', 'google', 'gooegl', 'cat', 'act', 'tac', 'dog'];
$groups = []; foreach ($words as $w) { $k = str_split($w); sort($k); $groups[implode($k)][] = $w; } ksort($groups); foreach ($groups as $k => $g) echo "$k: ", implode(",", $g), "\n";
// matrix multiplication
function matmul($a, $b) { $r = []; $n = count($a); $m = count($b[0]); $p = count($b); for ($i = 0; $i < $n; $i++) for ($j = 0; $j < $m; $j++) { $s = 0; for ($k = 0; $k < $p; $k++) $s += $a[$i][$k] * $b[$k][$j]; $r[$i][$j] = $s; } return $r; }
echo json_encode(matmul([[1, 2], [3, 4]], [[5, 6], [7, 8]])), "\n";
// towers of hanoi, gcd, permutations
function hanoi($n, $a, $b, $c, &$moves) { if ($n == 0) return; hanoi($n - 1, $a, $c, $b, $moves); $moves[] = "$a->$c"; hanoi($n - 1, $b, $a, $c, $moves); }
$mv = []; hanoi(4, 'A', 'B', 'C', $mv); echo count($mv), " ", $mv[0], " ", $mv[14], "\n";
function gcd($a, $b) { return $b ? gcd($b, $a % $b) : $a; } echo gcd(1071, 462), " ", gmp_like_lcm(4, 6), "\n";
function gmp_like_lcm($a, $b) { return $a / gcd($a, $b) * $b; }
function permute($items) { if (count($items) <= 1) return [$items]; $r = []; foreach ($items as $i => $it) { $rest = $items; unset($rest[$i]); foreach (permute(array_values($rest)) as $p) $r[] = array_merge([$it], $p); } return $r; }
echo implode(" ", array_map('implode', permute(['a', 'b', 'c']))), "\n";
// bank account simulation with exceptions
class InsufficientFunds extends Exception {}
class Account { private float $balance = 0; private array $log = []; public function __construct(public readonly string $owner) {}
  public function deposit(float $amt): static { if ($amt <= 0) throw new InvalidArgumentException("Deposit must be positive"); $this->balance += $amt; $this->log[] = "+$amt"; return $this; }
  public function withdraw(float $amt): static { if ($amt > $this->balance) throw new InsufficientFunds(sprintf("Cannot withdraw %.2f from %.2f", $amt, $this->balance)); $this->balance -= $amt; $this->log[] = "-$amt"; return $this; }
  public function balance(): float { return $this->balance; } public function history(): string { return implode(' ', $this->log); } }
$acc = new Account("Ann"); $acc->deposit(100)->withdraw(30)->deposit(5.5);
try { $acc->withdraw(1000); } catch (InsufficientFunds $e) { echo $e->getMessage(), "\n"; }
try { $acc->deposit(-1); } catch (InvalidArgumentException $e) { echo $e->getMessage(), "\n"; }
printf("%s: %.2f [%s]\n", $acc->owner, $acc->balance(), $acc->history());
// collatz & number formatting
$maxLen = 0; $best = 0; for ($i = 1; $i < 10000; $i++) { $n = $i; $len = 1; while ($n != 1) { $n = $n % 2 ? 3 * $n + 1 : $n >> 1; $len++; } if ($len > $maxLen) { $maxLen = $len; $best = $i; } } echo "$best $maxLen\n";
echo str_pad(number_format(1234567.891, 2), 20, ' ', STR_PAD_LEFT), "|\n";
// roman numerals
function roman($n) { $map = ['M' => 1000, 'CM' => 900, 'D' => 500, 'CD' => 400, 'C' => 100, 'XC' => 90, 'L' => 50, 'XL' => 40, 'X' => 10, 'IX' => 9, 'V' => 5, 'IV' => 4, 'I' => 1]; $r = ''; foreach ($map as $s => $v) { while ($n >= $v) { $r .= $s; $n -= $v; } } return $r; }
echo roman(1994), " ", roman(2024), " ", roman(3999), "\n";
// big int arithmetic overflow to float
$f = 1; for ($i = 1; $i <= 25; $i++) $f *= $i; var_dump($f); var_dump(PHP_INT_MAX * 2, 2**62 + 2**62, -PHP_INT_MAX - 2, 0.1 + 0.2 === 0.3, abs(PHP_INT_MIN));
