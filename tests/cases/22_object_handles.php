<?php
// Object handles: freed objects' ids are reused (as in PHP), live objects' never are.

// freed objects give their id back
$a = new stdClass;
$id = spl_object_id($a);
unset($a);
var_dump(spl_object_id(new stdClass) === $id);

// an object a constructor stores stays alive
class Box { public $v; function __construct($v) { $this->v = $v; } }
$box = new Box(new stdClass);
$other = new stdClass;
var_dump(spl_object_id($box->v) !== spl_object_id($other));

// so does one held by a reflection object
$r = new ReflectionObject(new stdClass);
$o2 = new stdClass;
var_dump(spl_object_id($o2) - spl_object_id($r));

// objects in a large returned array stay alive
function make() { $list = []; for ($i = 0; $i < 100; $i++) { $o = new stdClass; $list[] = $o; } return $list; }
$list = make();
$ids = array_map('spl_object_id', $list);
var_dump(in_array(spl_object_id(new stdClass), $ids, true));
var_dump(count(array_unique($ids)));

// garbage cycles keep their ids until cycle collection
$c = new stdClass; $c->self = $c;
$cid = spl_object_id($c);
unset($c);
var_dump(spl_object_id(new stdClass) !== $cid);
