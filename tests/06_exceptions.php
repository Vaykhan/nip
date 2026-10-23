<?php
class MyEx extends Exception { public function __construct($m, private $extra = 'X') { parent::__construct($m, 42); } public function getExtra() { return $this->extra; } }
function thrower($t) { if ($t == 1) throw new MyEx("custom"); if ($t == 2) throw new InvalidArgumentException("bad arg", 7); if ($t == 3) return intdiv(1, 0); return "ok"; }
foreach ([0, 1, 2, 3] as $t) {
  try { echo thrower($t), "\n"; }
  catch (MyEx $e) { echo "MyEx: ", $e->getMessage(), " ", $e->getCode(), " ", $e->getExtra(), " line ", $e->getLine(), "\n"; }
  catch (InvalidArgumentException | TypeError $e) { echo get_class($e), ": ", $e->getMessage(), " ", $e->getCode(), "\n"; }
  catch (Throwable $e) { echo "Throwable ", get_class($e), ": ", $e->getMessage(), "\n"; }
  finally { echo "finally $t\n"; }
}
function withFinally() { try { return "try"; } finally { echo "in finally\n"; } }
echo withFinally(), "\n";
function finallyOverride() { try { return "try"; } finally { return "finally"; } }
echo finallyOverride(), "\n";
function nested() { try { try { throw new RuntimeException("inner"); } finally { echo "inner finally\n"; } } catch (Exception $e) { echo "caught ", $e->getMessage(), "\n"; throw new LogicException("outer", 0, $e); } }
try { nested(); } catch (LogicException $e) { echo $e->getMessage(), " prev=", $e->getPrevious()->getMessage(), " ", get_class($e->getPrevious()), "\n"; }
try { throw new ErrorException("ee", 1, E_WARNING, "file.php", 10); } catch (ErrorException $e) { echo $e->getSeverity(), $e->getFile(), $e->getLine(), "\n"; }
set_error_handler(function($no, $str, $file, $line) { echo "handler: [$no] $str\n"; return true; });
echo $undefined_var;
$arr = []; echo $arr['missing'];
echo 10 / "5x";
restore_error_handler();
set_error_handler(function($no, $str) { throw new ErrorException($str, 0, $no); });
try { echo [] . ""; } catch (ErrorException $e) { echo "converted: ", $e->getMessage(), "\n"; }
restore_error_handler();
try { null->foo(); } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { $x = null; $x->bar = 1; } catch (Error $e) { echo $e->getMessage(), "\n"; }
try { (function(int $i) {})("abc"); } catch (TypeError $e) { echo substr($e->getMessage(), 0, 60), "\n"; }
try { echo match(99) { 1 => 'a', 2 => 'b' }; } catch (\UnhandledMatchError $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; }
try { [] > 0 ? 1 : 0; new DateTime("garbage-date-xyz"); } catch (Exception $e) { echo "date exception\n"; }
try { throw new Exception(); } catch (Exception $e) { var_dump($e->getMessage(), $e->getCode()); }
$e = new Exception("msg"); echo get_class($e), " ", $e instanceof Throwable ? 'T' : '', " ", $e->getLine(), "\n";
try { try { throw new Exception("a"); } catch (Exception $e) { throw $e; } } catch (Exception $e2) { echo "rethrown ", $e2->getMessage(), "\n"; }
function gen() { try { yield 1; yield 2; } finally { echo "gen finally\n"; } }
foreach (gen() as $v) echo $v, "\n";
try { throw new TypeError("custom type error"); } catch (Error $e) { echo get_class($e), "\n"; }
echo (new Exception("tostring test"))->getMessage(), "\n";
$ex = new RuntimeException("trace"); echo $ex->getTraceAsString(), "\n";
function lvl2() { throw new Exception("deep"); } function lvl1() { lvl2(); }
try { lvl1(); } catch (Exception $e) { echo $e->getTraceAsString(), "\n"; echo count($e->getTrace()), " ", $e->getTrace()[0]['function'], "\n"; }
try { throw new DivisionByZeroError("x"); } catch (ArithmeticError $e) { echo "arith\n"; }
try { echo 1 % 0; } catch (DivisionByZeroError $e) { echo $e->getMessage(), "\n"; }
try { strlen(); } catch (ArgumentCountError $e) { echo $e->getMessage(), "\n"; }
try { new SplFixedArray(-1); } catch (ValueError $e) { echo get_class($e), "\n"; }
echo "before uncaught\n";
function cleanup() { echo "shutdown ran\n"; }
register_shutdown_function('cleanup');
throw new MyEx("final uncaught");
