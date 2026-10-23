<?php
$a = 1; $b = &$a; $b = 2; echo $a, "\n"; unset($b); $b = 3; echo $a, "\n";
$arr = [1, 2, 3]; $ref = &$arr[1]; $ref = 'x'; print_r($arr); $copy = $arr; $ref = 'y'; print_r($copy); print_r($arr);
function addOne(array &$a) { foreach ($a as &$v) $v++; }
$nums = [1, 2, 3]; addOne($nums); print_r($nums);
$data = ['a' => ['b' => 1]]; $inner = &$data['a']; $inner['c'] = 2; print_r($data);
$list = [1, 2, 3]; foreach ($list as &$item) {} foreach ($list as $item) {} print_r($list);
$x = ['k' => 1]; $y = &$x; $y['k'] = 2; echo $x['k'], "\n";
$o = new stdClass; $o->v = 1; $o2 = $o; $o2->v = 2; echo $o->v, "\n";
function &counter() { static $c = 0; $c++; return $c; } $c1 = &counter(); $c1 += 10; echo counter(), "\n";
$matrix = [[1, 2], [3, 4]]; foreach ($matrix as &$row) foreach ($row as &$cell) $cell *= 10; unset($row, $cell); print_r($matrix);
$s = 'str'; $sr = &$s; $sr .= 'ing'; echo $s, "\n";
$arr2 = [3, 1, 2]; $alias = &$arr2; sort($alias); print_r($arr2);
function swap(&$a, &$b) { [$a, $b] = [$b, $a]; } $p = 1; $q = 2; swap($p, $q); echo "$p $q\n";
$config = ['db' => ['host' => 'x']]; $h = &$config['db']['host']; $h = 'localhost'; echo $config['db']['host'], "\n";
$objs = [new stdClass, new stdClass]; foreach ($objs as $i => $ob) $ob->id = $i; echo $objs[1]->id, "\n";
$fns = []; for ($i = 0; $i < 3; $i++) { $fns[] = function() use ($i) { return $i; }; } echo $fns[0](), $fns[2](), "\n";
$total = 0; array_walk($nums, function($v) use (&$total) { $total += $v; }); echo $total, "\n";
$arr3 = ['x' => 1]; $fn = function() use (&$arr3) { $arr3['y'] = 2; }; $fn(); print_r($arr3);
$g = 'global'; function readGlobal() { global $g; return $g; } echo readGlobal(), " ", $GLOBALS['g'], "\n";
function setGlobal() { $GLOBALS['newg'] = 'set'; } setGlobal(); echo $newg, "\n";
$aa = [1, 2]; $bb = $aa; $bb[] = 3; echo count($aa), count($bb), "\n";
$nested = ['l1' => ['l2' => ['l3' => 'deep']]]; $n2 = $nested; $n2['l1']['l2']['l3'] = 'changed'; echo $nested['l1']['l2']['l3'], $n2['l1']['l2']['l3'], "\n";
$arrOfArr = [[1], [2]]; foreach ($arrOfArr as $k => $sub) { $sub[] = 'x'; $arrOfArr[$k] = $sub; } echo json_encode($arrOfArr), "\n";
$st = new stdClass; $st->list = [1]; $l = $st->list; $l[] = 2; echo count($st->list), "\n";
$st->list[] = 3; echo count($st->list), "\n";
$refArr = []; $refArr['a'] = &$undefinedYet; $undefinedYet = 5; echo $refArr['a'], "\n";
function modArr($arr) { $arr['x'] = 'modified'; return $arr; } $orig = ['x' => 'orig']; modArr($orig); echo $orig['x'], "\n";
$v1 = [1,2,3]; $v2 = &$v1[0]; $v3 = $v1; $v3[0] = 99; echo $v1[0], "\n";
$str = "abc"; $chars = str_split($str); foreach ($chars as $i => &$ch) $ch = strtoupper($ch); unset($ch); echo implode($chars), "\n";
class Reg { private array $items = []; public function &get($k) { if (!isset($this->items[$k])) $this->items[$k] = []; return $this->items[$k]; } public function all() { return $this->items; } }
$reg = new Reg; $r = &$reg->get('a'); $r[] = 1; print_r($reg->all());
