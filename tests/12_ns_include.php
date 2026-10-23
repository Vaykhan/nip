<?php
namespace Main;
use App\Util\Str;
use App\Util\Str as S2;
use function App\Util\greet;
use const App\Util\VERSION;
$outer = 'outer';
$ret = require __DIR__ . '/inc/helper.php';
var_dump($ret);
include 'inc/vars.php';
echo $included_var, "\n";
echo greet('Bob'), " ", Str::up('x'), " ", S2::up('y'), " ", VERSION, " ", \App\Util\Str::class, " ", Str::class, "\n";
var_dump(require_once __DIR__ . '/inc/helper.php');
class Local { } echo Local::class, " ", get_class(new Local), " ", __NAMESPACE__, "\n";
function localFn() { return __FUNCTION__; } echo localFn(), " ", \strlen("abc"), " ", strtoupper("fallback"), "\n";
echo namespace\localFn(), "\n";
interface I {} class Impl implements I {} var_dump(new Impl instanceof I, new Impl instanceof \Main\I);
$cls = '\Main\Local'; $o = new $cls; echo get_class($o), "\n";
$r = @include 'nonexistent.php'; var_dump($r);
echo \PHP_EOL === "\n" ? "eol ok" : "no", "\n";
try { throw new \RuntimeException("ns exception"); } catch (\Exception $e) { echo get_class($e), "\n"; }
echo json_encode(array_map(fn($x) => $x * 2, [1, 2])), "\n";
