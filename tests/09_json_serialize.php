<?php
$data = ['name' => 'Test', 'n' => 42, 'f' => 3.14, 'b' => true, 'null' => null, 'list' => [1, 2, 3], 'obj' => ['k' => 'v'], 'empty' => [], 'unicode' => 'héllo €', 'slash' => 'a/b', 'quote' => 'say "hi"'];
echo json_encode($data), "\n";
echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
echo json_encode([1 => 'a', 2 => 'b']), json_encode([0 => 'a', 1 => 'b']), json_encode([], JSON_FORCE_OBJECT), json_encode(3.0), json_encode(3.0, JSON_PRESERVE_ZERO_FRACTION), json_encode("12", JSON_NUMERIC_CHECK), "\n";
echo json_encode("<tag>&'\"", JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT), json_encode(0.1), json_encode(1e100), json_encode(-0.0), json_encode(PHP_INT_MAX), "\n";
var_dump(json_decode('{"a":1,"b":[1,2,{"c":null}],"d":1.5,"e":"xé"}', true));
$o = json_decode('{"a":{"b":2},"list":[1,2]}'); echo $o->a->b, " ", $o->list[1], " ", get_class($o), "\n";
var_dump(json_decode('invalid'), json_last_error(), json_last_error_msg(), json_decode('[1,2'), json_decode('"str"'), json_decode('123'), json_decode('1.0'), json_decode('12345678901234567890'), json_decode(''), json_last_error());
try { json_decode('{bad}', false, 512, JSON_THROW_ON_ERROR); } catch (JsonException $e) { echo "JsonException: ", $e->getMessage(), " ", $e->getCode(), "\n"; }
var_dump(json_encode(NAN), json_last_error_msg(), json_encode("\xB1\x31"), json_last_error());
echo json_encode(['a' => ['b' => ['c' => []]]], JSON_PRETTY_PRINT), "\n";
echo json_encode((object)[]), json_encode([[]]), json_encode(['x' => (object)['y' => 1]]), "\n";
var_dump(json_decode('[]'), (array)json_decode('{}'), json_decode('{"0":"a","1":"b"}', true), json_decode(' true '));
$s = serialize(['a' => 1, 'b' => [true, null, 1.5, 'str'], 'c' => -5]); echo $s, "\n"; var_dump(unserialize($s));
class SP { public $pub = 1; protected $pro = 2; private $pri = 3; public $arr = ['x']; }
$ser = serialize(new SP); echo str_replace("\0", '~', $ser), "\n"; print_r(unserialize($ser));
class Custom { public $a = 1; public $b = 2; public function __sleep() { return ['a']; } public function __wakeup() { echo "wakeup\n"; } }
$c = unserialize(serialize(new Custom)); print_r($c);
class Modern { public function __construct(public $x = 5) {} public function __serialize(): array { return ['xx' => $this->x]; } public function __unserialize(array $d): void { $this->x = $d['xx'] * 2; } }
echo serialize(new Modern), " "; print_r(unserialize(serialize(new Modern)));
var_dump(unserialize('garbage'), unserialize(serialize(false)), unserialize(serialize(1.0)), unserialize('i:5;'), unserialize('s:3:"abc";'));
var_export(['a' => 1, 'b' => [true, null], 'c' => 1.5, 'd' => "it's"]); echo "\n"; var_export(1.0); echo "\n"; var_export("x"); echo "\n"; var_export(false); echo "\n";
echo var_export([1, 2], true), "\n"; var_export(new SP); echo "\n";
echo json_encode(['float' => 10.0/3]), "\n";
echo json_encode("€", JSON_UNESCAPED_UNICODE), json_encode("😀"), "\n";
var_dump(json_decode('"😀"'), json_decode('{"a":"é"}')->a);
echo json_encode([1=>1, 0=>0]), json_encode(['a', 'b'], JSON_FORCE_OBJECT), "\n";
var_dump(json_decode('[1, 2, 3]', true, 1), json_last_error_msg());
