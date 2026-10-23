<?php
$items = ['a', 'b'];
if (count($items) > 1): echo "many\n"; elseif (count($items) == 1): echo "one\n"; else: echo "none\n"; endif;
foreach ($items as $i): echo $i; endforeach; echo "\n";
for ($i = 0; $i < 3; $i++): echo $i; endfor; echo "\n";
$n = 0; while ($n < 3): $n++; endwhile; echo $n, "\n";
switch ($n): case 3: echo "three\n"; break; default: echo "other\n"; endswitch;
?>
Inline HTML <?= $n ?> and <?php echo "php"; ?> again
<?php if ($n > 2) { ?>
  shown block
<?php } else { ?>
  hidden block
<?php } ?>
<?php
$varName = 'dynamic'; $$varName = 'value'; echo $dynamic, " ", ${'dyn' . 'amic'}, "\n";
$func = 'strtoupper'; echo $func('x'), "\n";
$method = 'format'; $obj = new class { function format($x) { return "[$x]"; } }; echo $obj->$method('y'), " ", $obj->{'for' . 'mat'}('z'), "\n";
$class = 'ArrayObject'; $ao = new $class([1, 2]); echo count($ao), "\n";
$static = 'count'; echo [new ArrayObject([1]), $static](), "\n";
switch ("2") { case 2: echo "loose match\n"; break; case "2": echo "never\n"; }
switch (true) { case $n > 5: echo "big"; break; case $n > 1: echo "medium"; // fallthrough
  case false: echo "-fall"; break; } echo "\n";
for ($i = 0, $j = 10; $i < $j; $i += 3, $j -= 3); echo "$i $j\n";
$k = 0; do { $k++; if ($k == 2) continue; if ($k > 4) break; echo $k; } while (true); echo "\n";
for ($i = 0; $i < 3; $i++) { for ($j = 0; $j < 3; $j++) { if ($j == 1) continue 2; if ($i == 2) break 2; echo "$i$j "; } } echo "\n";
$x = 5; $y = $x > 3 ? ($x > 4 ? "big" : "mid") : "small"; echo $y, "\n";
echo 10 <=> 5, PHP_EOL;
$a = null; echo $a?->foo?->bar ?? "nullsafe", "\n";
$arr = ['x' => ['y' => null]]; echo $arr['x']['y']['z'] ?? 'deep-default', "\n";
$v = $undefined ?? 'undef-default'; echo $v, "\n";
$counter = 0; $counter ??= 10; $counter ??= 20; echo $counter, "\n";
$s = 'abc'; echo "{$s[0]}{$s[-1]}", "\n";
echo "Math: " . 2 + 3 . "\n";
echo -2 ** 2, " ", (-2) ** 2, " ", 2 ** 3 ** 2, " ", 7 % 3 * 2, " ", !true || true, "\n";
$bits = 0b1100; echo $bits & 0b1010, " ", $bits | 1, " ", $bits ^ 0b1111, " ", $bits << 2, " ", $bits >> 1, " ", ~$bits & 0xF, "\n";
var_dump(true && false || true, true and false, (true xor true), !empty([0]), isset($nope, $s));
const MY_CONST = 'c1'; define('OTHER', MY_CONST . '2'); echo MY_CONST, OTHER, defined('OTHER') ? 'y' : 'n', "\n";
echo __LINE__, " ", basename(__FILE__), " ", basename(__DIR__), "\n";
list('a' => $la, 'b' => list($lb1, $lb2)) = ['a' => 1, 'b' => [2, 3]]; echo $la + $lb1 + $lb2, "\n";
[$p, , $r] = [1, 2, 3]; echo $p . $r, "\n";
foreach (['x' => [1, 2]] as $key => [$f1, $f2]) echo "$key $f1 $f2\n";
$i = 10; $result = $i++ + ++$i; echo $result, " ", $i, "\n";
$str = "x"; $str .= "y" . "z"; echo $str, "\n";
echo intval("  42  "), intval("0x1A", 16), intval("012", 0), intval("101", 2), " ", octdec("17"), hexdec("ff"), bindec("11"), "\n";
print("print works\n"); $pr = print ""; echo $pr, "\n";
echo <<<HTML
  <div class="{$s}">
    {$arr['x']['y']}text
  </div>
  HTML;
echo "\n";
