<?php
enum Suit: string {
  case Hearts = 'H'; case Diamonds = 'D'; case Clubs = 'C'; case Spades = 'S';
  const Wild = self::Spades;
  public function color(): string { return match($this) { self::Hearts, self::Diamonds => 'Red', self::Clubs, self::Spades => 'Black' }; }
  public function label(): string { return ucfirst(strtolower($this->name)); }
  public static function fromChar(string $c): self { return self::from($c); }
}
enum Status { case Active; case Inactive; }
interface HasLabel { public function label(): string; }
enum Size: int implements HasLabel { case S = 1; case M = 2; case L = 3; public function label(): string { return "Size " . $this->name; } }
echo Suit::Hearts->value, " ", Suit::Hearts->name, " ", Suit::Hearts->color(), " ", Suit::from('C')->label(), " ", Suit::tryFrom('X') === null ? 'null' : 'x', "\n";
echo count(Suit::cases()), " ", Suit::cases()[1]->name, " ", Suit::Wild->name, " ", Suit::fromChar('D')->color(), "\n";
var_dump(Suit::Hearts === Suit::Hearts, Suit::Hearts == Suit::Spades, Suit::Hearts instanceof Suit, Suit::Hearts instanceof UnitEnum, Suit::Hearts instanceof BackedEnum, Status::Active instanceof BackedEnum);
var_dump(Status::Active); var_dump(Suit::Clubs); echo Size::M->label(), " ", Size::from(3)->name, " ", Size::tryFrom(9) ?? 'none', "\n";
try { Suit::from('Z'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
$fn = fn(Suit $s) => $s->name; echo $fn(Suit::Spades), "\n";
echo json_encode(['s' => Suit::Hearts, 'z' => Size::L]), "\n";
print_r(array_map(fn($c) => $c->value, Suit::cases()));
$x = 5;
echo match(true) { $x < 3 => "small", $x < 10 => "medium", default => "large" }, "\n";
echo match($x) { 1, 2, 3 => 'low', 4, 5, 6 => 'mid', default => 'high' }, "\n";
$r = match('a') { 'a' => fn() => 'closure result', 'b' => null }; echo $r(), "\n";
var_dump(Status::Active->name, constant('Suit::Hearts')->value, Suit::Hearts::class);
final class Point { public function __construct(public readonly int $x = 0, public readonly int $y = 0) {} public function withX(int $x): static { return new static($x, $this->y); } }
$p = new Point(1, 2); $p2 = $p->withX(5); echo $p->x, $p2->x, $p2->y, "\n";
try { $p->x = 10; } catch (Error $e) { echo $e->getMessage(), "\n"; }
readonly class Money { public function __construct(public int $amount, public string $cur) {} }
$m = new Money(100, 'USD'); echo $m->amount, $m->cur, "\n"; try { $m->amount = 5; } catch (Error $e) { echo $e->getMessage(), "\n"; }
enum Planet: int { case Mercury = 1; case Venus = 2; public function mass(): float { return match($this) { Planet::Mercury => 3.303e+23, Planet::Venus => 4.869e+24 }; } const G = 6.67300E-11; public function gravity(): float { return self::G * $this->mass() / (2.4397e6 ** 2); } }
printf("%.2f\n", Planet::Mercury->gravity());
$map = new SplObjectStorage; $map[Suit::Hearts] = 'love'; echo $map[Suit::Hearts], "\n";
$arr = [Suit::Hearts->value => 1]; print_r($arr);
var_dump(Suit::Hearts <=> Suit::Hearts);
echo gettype(Suit::Hearts), " ", get_class(Status::Inactive), "\n";
var_dump(enum_exists('Suit'), enum_exists('Point'), Suit::Hearts instanceof HasLabel, Size::S instanceof HasLabel);
