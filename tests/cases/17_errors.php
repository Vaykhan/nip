<?php
echo $undef1;
$arr = [1]; echo $arr[3]; echo $arr['x'];
$str = "abc"; echo $str[10];
echo "x" . [1], "\n";
$n = null; echo $n['k']; echo $n->p;
$i = 5; echo $i['k'];
echo 10 % 3, intdiv(10, 3), "\n";
$o = new stdClass; echo $o->missing;
echo "5 apples" + 3, "\n";
echo (int)"1e3", " ", "1e3" + 0, " ", "0x10" + 0, "\n";
$x = "abc"; $x++; echo $x, "\n";
function f(int ...$n) { return array_sum($n); } echo f(1, 2), "\n";
class A { public function __get($n) { trigger_error("No prop $n", E_USER_WARNING); return null; } }
(new A)->foo;
trigger_error("custom notice");
trigger_error("custom deprecated", E_USER_DEPRECATED);
@trigger_error("silenced", E_USER_WARNING);
$r = @$arr['nope']; var_dump($r);
error_reporting(E_ALL & ~E_WARNING); echo $undef2; error_reporting(E_ALL);
echo str_repeat("-", 3), "\n";
var_dump(error_get_last()['message'] ?? null);
function thrower() { throw new LogicException("from function"); }
function caller() { thrower(); }
class K { function m() { caller(); } static function s() { (new K)->m(); } }
try { K::s(); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; }
echo array_sum([1, 2, "3"]), "\n";
$list = [3 => 'a']; $list[] = 'b'; var_dump(array_key_last($list));
echo implode(",", [true, false, null, 1.5, "s"]), "\n";
var_dump("abc" == "ABC", "1" == "1.0", "abc" == "abc ", null == 0, "" == null, [] == false, "0" == false, " " == 0);
var_dump(1 + 1.0, "3" * "4", "2" ** 3, 7 / 7, 2 ** 0.5, -7 % 3, 7.5 % 2);
K::s();
