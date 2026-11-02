<?php
// Reflection and attributes, used the way frameworks use them: a constructor-injection container,
// attribute-based routing, property access, enums, closures and type inspection.

#[Attribute(Attribute::TARGET_METHOD | Attribute::IS_REPEATABLE)]
final class Route {
    public function __construct(public string $path, public array $methods = ['GET']) {}
}
#[Attribute(Attribute::TARGET_PROPERTY)]
final class Inject {}

interface LoggerInterface { public function log(string $m): void; }
final class Logger implements LoggerInterface {
    public array $lines = [];
    public function log(string $m): void { $this->lines[] = $m; }
}
final class Mailer {
    public function __construct(private LoggerInterface $logger, private string $from = 'noreply@example.com') {}
    public function send(string $to): string { $this->logger->log("mail to $to"); return "$this->from -> $to"; }
}

/** A tiny autowiring container. */
final class Container {
    private array $instances = [];
    private array $bindings = [LoggerInterface::class => Logger::class];
    public function get(string $id): object {
        if (isset($this->instances[$id])) return $this->instances[$id];
        $class = new ReflectionClass($this->bindings[$id] ?? $id);
        if (!$class->isInstantiable()) throw new LogicException("$id is not instantiable");
        $args = [];
        foreach ($class->getConstructor()?->getParameters() ?? [] as $p) {
            $t = $p->getType();
            if ($t instanceof ReflectionNamedType && !$t->isBuiltin()) $args[] = $this->get($t->getName());
            elseif ($p->isDefaultValueAvailable()) $args[] = $p->getDefaultValue();
        }
        return $this->instances[$id] = $class->newInstanceArgs($args);
    }
}

class UserController {
    #[Route('/users')]
    public function index(): string { return 'list'; }
    #[Route('/users/{id}', methods: ['GET', 'HEAD'])]
    #[Route('/u/{id}')]
    public function show(int $id): string { return "user $id"; }
    protected function helper() {}
}

$c = new Container();
$mailer = $c->get(Mailer::class);
echo $mailer->send('a@b.c'), "\n";
echo implode(',', $c->get(LoggerInterface::class)->lines), "\n";

$routes = [];
foreach ((new ReflectionClass(UserController::class))->getMethods(ReflectionMethod::IS_PUBLIC) as $m) {
    foreach ($m->getAttributes(Route::class) as $attr) {
        $r = $attr->newInstance();
        $routes[] = implode('|', $r->methods) . ' ' . $r->path . ' => ' . $m->class . '::' . $m->getName();
    }
}
echo implode("\n", $routes), "\n";
echo (new ReflectionMethod(UserController::class, 'show'))->invoke(new UserController, 7), "\n";

// properties
class Account {
    public function __construct(private int $balance = 10, protected ?string $owner = null) {}
    public static int $count = 0;
    #[Inject] public LoggerInterface $logger;
}
$acc = new Account(5);
$rp = new ReflectionProperty(Account::class, 'balance');
echo $rp->getName(), ' private=', var_export($rp->isPrivate(), true), ' promoted=', var_export($rp->isPromoted(), true), ' type=', $rp->getType(), ' value=', $rp->getValue($acc), "\n";
$rp->setValue($acc, 99);
echo 'after set: ', $rp->getValue($acc), "\n";
$rl = new ReflectionProperty(Account::class, 'logger');
echo 'initialized: ', var_export($rl->isInitialized($acc), true), ', attrs: ', implode(',', array_map(fn($a) => $a->getName(), $rl->getAttributes())), "\n";
echo 'props: ', implode(' ', array_map(fn($p) => implode(' ', Reflection::getModifierNames($p->getModifiers())) . ' $' . $p->getName(), (new ReflectionClass($acc))->getProperties())), "\n";
echo 'statics: ', json_encode((new ReflectionClass(Account::class))->getStaticProperties()), "\n";

// types and parameters
function sample(int|string $a, ?Account $b = null, Account|array ...$rest): ?iterable { return null; }
foreach ((new ReflectionFunction('sample'))->getParameters() as $p) {
    $t = $p->getType();
    echo '#', $p->getPosition(), ' $', $p->getName(), ': ', get_class($t), ' ', $t, ' nullable=', var_export($t->allowsNull(), true),
        ' optional=', var_export($p->isOptional(), true), ' variadic=', var_export($p->isVariadic(), true), "\n";
}
echo 'returns: ', (new ReflectionFunction('sample'))->getReturnType(), "\n";

// enums and constants
enum Suit: string {
    case Hearts = 'H';
    case Spades = 'S';
    const Wild = self::Spades;
    public function color(): string { return $this === self::Hearts ? 'Red' : 'Black'; }
}
$re = new ReflectionEnum(Suit::class);
echo 'backed: ', $re->getBackingType(), ', cases: ', implode(',', array_map(fn($c) => $c->getName() . '=' . $c->getBackingValue(), $re->getCases())), "\n";
echo 'constants: ', implode(',', array_keys($re->getConstants())), ', final: ', var_export($re->isFinal(), true), "\n";

// closures
$factor = 3;
$fn = function (int $x) use ($factor): int { static $calls = 0; $calls++; return $x * $factor; };
$rf = new ReflectionFunction($fn);
echo $rf->getName(), ' params=', $rf->getNumberOfParameters(), ' result=', $rf->invoke(4), ' vars=', json_encode($rf->getStaticVariables()), "\n";

// errors
foreach ([fn() => new ReflectionClass('Nope'), fn() => new ReflectionMethod(Mailer::class, 'nope'), fn() => (new ReflectionClass(UserController::class))->getProperty('x')] as $f) {
    try { $f(); } catch (ReflectionException $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
}
try { (new ReflectionMethod(Container::class, 'get'))->invoke(null, 'x'); } catch (ReflectionException $e) { echo $e->getMessage(), "\n"; }
