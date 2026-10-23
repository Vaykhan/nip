<?php
interface Shape { const SIDES = 0; public function area(): float; }
abstract class Base implements Shape {
  protected static int $count = 0;
  public function __construct(protected string $name) { static::$count++; self::log("created $name"); }
  abstract public function area(): float;
  public static function count(): int { return static::$count; }
  private static function log($m) { echo "[log] $m\n"; }
  public function __toString(): string { return sprintf("%s(%.2f)", $this->name, $this->area()); }
  public function describe() { return static::class . " " . get_class($this) . " " . self::class . " " . get_parent_class($this); }
}
class Circle extends Base { const SIDES = 1; public function __construct(private float $r) { parent::__construct("circle"); } public function area(): float { return M_PI * $this->r ** 2; } }
final class Rect extends Base { const SIDES = 4; public function __construct(public readonly float $w, public readonly float $h) { parent::__construct("rect"); } public function area(): float { return $this->w * $this->h; } }
$shapes = [new Circle(2), new Rect(3, 4)];
foreach ($shapes as $s) echo $s, " ", $s::SIDES, " ", $s instanceof Shape ? 'yes' : 'no', "\n";
echo Base::count(), " ", Circle::count(), " ", $shapes[1]->describe(), "\n";
try { $shapes[1]->w = 5; } catch (Error $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { new Base("x"); } catch (Error $e) { echo $e->getMessage(), "\n"; }
usort($shapes, fn($a, $b) => $a->area() <=> $b->area()); echo implode(", ", $shapes), "\n";
class Magic {
  private array $data = [];
  public function __get($n) { echo "get $n\n"; return $this->data[$n] ?? null; }
  public function __set($n, $v) { echo "set $n\n"; $this->data[$n] = $v; }
  public function __isset($n) { return isset($this->data[$n]); }
  public function __unset($n) { unset($this->data[$n]); }
  public function __call($n, $a) { return "$n(" . implode(",", $a) . ")"; }
  public static function __callStatic($n, $a) { return "static $n"; }
  public function __invoke($x) { return $x * 2; }
}
$m = new Magic; $m->foo = 5; echo $m->foo, "\n"; var_dump(isset($m->foo), isset($m->bar)); unset($m->foo); var_dump(isset($m->foo));
echo $m->doThing(1, 2), " ", Magic::other(), " ", $m(21), "\n";
trait Greets { public $greeting = "Hello"; public function greet() { return "$this->greeting from " . static::class . " " . self::class . " " . __CLASS__ . " " . __TRAIT__; } abstract public function name(); public static function make() { return new static; } }
trait Counts { private int $n = 0; public function inc() { return ++$this->n; } }
class Person { use Greets, Counts { inc as protected incPriv; greet as hello; } public function name() { return "P"; } public function bump() { return $this->incPriv(); } }
$p = Person::make(); echo $p->greet(), " ", $p->hello(), " ", $p->bump(), $p->bump(), "\n";
print_r(class_uses($p)); var_dump(method_exists($p, 'greet'), property_exists('Person', 'greeting'));
class Node { public $children = []; public ?Node $parent = null; function __construct(public $val) {} function add(Node $c) { $c->parent = $this; $this->children[] = $c; return $this; } }
$root = (new Node(1))->add(new Node(2))->add(new Node(3)); echo count($root->children), " ", $root->children[1]->parent->val, "\n";
class P1 { public $a = 1; protected $b = 2; private $c = 3; public function vars() { return get_object_vars($this); } }
class P2 extends P1 { public $d = 4; }
$o = new P2; print_r(get_object_vars($o)); print_r($o->vars()); print_r($o); echo "\n";
foreach ($o as $k => $v) echo "$k=$v "; echo "\n";
$c1 = new P2; $c2 = clone $c1; $c2->a = 100; echo $c1->a, " ", $c2->a, "\n"; var_dump($c1 == $c2, $c1 == new P2, $c1 === $c1);
class Deep { public $inner; function __construct() { $this->inner = new stdClass; $this->inner->v = 1; } function __clone() { $this->inner = clone $this->inner; } }
$d1 = new Deep; $d2 = clone $d1; $d2->inner->v = 2; echo $d1->inner->v, $d2->inner->v, "\n";
class StaticHolder { public static $items = []; public static function add($i) { static::$items[] = $i; return new static; } }
StaticHolder::add(1); StaticHolder::add(2); print_r(StaticHolder::$items); StaticHolder::$items[] = 3; echo count(StaticHolder::$items), "\n";
abstract class Model { protected static $table; public static function table() { return static::$table; } public static function create(): static { return new static(); } }
class User extends Model { protected static $table = 'users'; } class Post extends Model { protected static $table = 'posts'; }
echo User::table(), Post::table(), get_class(User::create()), "\n";
class Cnt implements Countable, ArrayAccess, IteratorAggregate {
  private $c = [];
  public function count(): int { return count($this->c); }
  public function offsetExists($o): bool { return isset($this->c[$o]); }
  public function offsetGet($o): mixed { return $this->c[$o] ?? null; }
  public function offsetSet($o, $v): void { if ($o === null) $this->c[] = $v; else $this->c[$o] = $v; }
  public function offsetUnset($o): void { unset($this->c[$o]); }
  public function getIterator(): Iterator { return new ArrayIterator($this->c); }
}
$cn = new Cnt; $cn[] = 'a'; $cn['k'] = 'b'; echo count($cn), $cn['k'], isset($cn['k']) ? 'Y' : 'N', isset($cn['z']) ? 'Y' : 'N', "\n"; unset($cn['k']); echo count($cn), "\n";
foreach ($cn as $k => $v) echo "$k:$v\n";
echo json_encode(new Rect(1, 2)), "\n";
class JS implements JsonSerializable { public function jsonSerialize(): mixed { return ['custom' => true]; } } echo json_encode([new JS]), "\n";
$anon = new class(5) extends P1 { public function __construct(public $x) {} }; echo $anon->x, $anon->a, " ", $anon instanceof P1 ? 'P1' : '', "\n";
interface HasName { public function getName(); } interface HasAge { public function getAge(); }
class Emp implements HasName, HasAge { public function getName() { return 'n'; } public function getAge() { return 3; } }
print_r(class_implements(new Emp)); var_dump(is_subclass_of(new Emp, 'HasName'), is_a(new Emp, 'Emp'), new Emp instanceof HasAge);
class ParentC { public function who() { return 'parent'; } public function test() { return $this->who(); } private function priv() { return 'P-priv'; } public function callPriv() { return $this->priv(); } }
class ChildC extends ParentC { public function who() { return 'child'; } private function priv() { return 'C-priv'; } }
$cc = new ChildC; echo $cc->test(), " ", $cc->callPriv(), "\n";
class WithConst { const A = 'a'; const B = self::A . 'b'; const ARR = [1, 2, self::A]; }
echo WithConst::B, " ", WithConst::ARR[2], " ", constant('WithConst::A'), "\n";
class Ctr { public static function make(...$a) { return new self(...$a); } public function __construct(public $a = 0, public $b = 0) {} }
$ct = Ctr::make(b: 2); echo $ct->a, $ct->b, "\n";
$objs = [new Ctr(3), new Ctr(1), new Ctr(2)]; usort($objs, fn($x, $y) => $x->a - $y->a); echo $objs[0]->a, "\n";
$std = new stdClass; $std->{'weird key'} = 1; $prop = 'dyn'; $std->$prop = 2; print_r($std); var_dump(isset($std->dyn), empty($std->nope));
$arr = (array) $std; print_r($arr); $back = (object) ['a' => 1, 'b' => [1, 2]]; echo $back->b[1], "\n";
class Destr { function __construct(public $n) {} function __destruct() { echo "destroy {$this->n}\n"; } }
function scope() { $d = new Destr('inner'); echo "in scope\n"; }
scope(); echo "after scope\n";
class Chain { private $parts = []; public function __call($m, $a) { $this->parts[] = $m; return $this; } public function __toString(): string { return implode('.', $this->parts); } }
echo (new Chain)->a()->b()->c(), "\n";
echo new class { public function __toString(): string { return "anon-str"; } }, "\n";
var_dump((string) new Chain === '', strlen(new Chain));
