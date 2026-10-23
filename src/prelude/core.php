<?php
interface Traversable {}
interface Iterator extends Traversable { function current(): mixed; function key(): mixed; function next(): void; function rewind(): void; function valid(): bool; }
interface IteratorAggregate extends Traversable { function getIterator(): Iterator; }
interface ArrayAccess { function offsetExists(mixed $offset): bool; function offsetGet(mixed $offset): mixed; function offsetSet(mixed $offset, mixed $value): void; function offsetUnset(mixed $offset): void; }
interface Countable { function count(): int; }
interface JsonSerializable { function jsonSerialize(): mixed; }
interface Stringable { function __toString(): string; }
interface Serializable { function serialize(); function unserialize(string $data); }
interface UnitEnum {}
interface BackedEnum extends UnitEnum {}
interface Throwable extends Stringable {}
interface OuterIterator extends Iterator { function getInnerIterator(): ?Iterator; }
interface SeekableIterator extends Iterator { function seek(int $offset): void; }
interface SplObserver { function update(SplSubject $subject): void; }
interface SplSubject { function attach(SplObserver $observer): void; function detach(SplObserver $observer): void; function notify(): void; }
interface DateTimeInterface {
  const ATOM = "Y-m-d\\TH:i:sP"; const COOKIE = "l, d-M-Y H:i:s T"; const ISO8601 = "Y-m-d\\TH:i:sO"; const ISO8601_EXPANDED = "X-m-d\\TH:i:sP";
  const RFC822 = "D, d M y H:i:s O"; const RFC850 = "l, d-M-y H:i:s T"; const RFC1036 = "D, d M y H:i:s O"; const RFC1123 = "D, d M Y H:i:s O";
  const RFC7231 = "D, d M Y H:i:s \\G\\M\\T"; const RFC2822 = "D, d M Y H:i:s O"; const RFC3339 = "Y-m-d\\TH:i:sP"; const RFC3339_EXTENDED = "Y-m-d\\TH:i:s.vP"; const RSS = "D, d M Y H:i:s O"; const W3C = "Y-m-d\\TH:i:sP";
}

trait __ThrowableImpl {
  public function __construct($message = "", $code = 0, $previous = null) { $this->message = $message; $this->code = $code; $this->previous = $previous; }
  final public function getMessage(): string { return $this->message; }
  final public function getCode() { return $this->code; }
  final public function getPrevious(): ?Throwable { return $this->previous; }
  final public function getFile(): string { return $this->file; }
  final public function getLine(): int { return $this->line; }
  final public function getTrace(): array { return __exception_trace($this); }
  final public function getTraceAsString(): string { return __exception_trace_string($this); }
  public function __toString(): string {
    $parts = [];
    $e = $this;
    while ($e !== null) {
      $m = $e->getMessage();
      if (($e instanceof TypeError) && (get_class($e) === 'TypeError' || get_class($e) === 'ArgumentCountError') && str_contains($m, ', called in ')) $m .= ' and defined';
      $parts[] = get_class($e) . ($m !== '' ? ': ' . $m : '') . ' in ' . $e->getFile() . ':' . $e->getLine() . "\nStack trace:\n" . $e->getTraceAsString();
      $e = $e->getPrevious();
    }
    return implode("\n\nNext ", array_reverse($parts));
  }
}
class Exception implements Throwable {
  protected $message = ''; protected $code = 0; protected string $file = ''; protected int $line = 0; protected ?Throwable $previous = null;
  use __ThrowableImpl;
}
class Error implements Throwable {
  protected $message = ''; protected $code = 0; protected string $file = ''; protected int $line = 0; protected ?Throwable $previous = null;
  use __ThrowableImpl;
}
class ErrorException extends Exception {
  protected int $severity = E_ERROR;
  public function __construct($message = "", $code = 0, $severity = E_ERROR, $filename = null, $line = null, $previous = null) {
    parent::__construct($message, $code, $previous);
    $this->severity = $severity;
    if ($filename !== null) { $this->file = $filename; $this->line = $line ?? 0; }
    elseif ($line !== null) $this->line = $line;
  }
  final public function getSeverity(): int { return $this->severity; }
}
class TypeError extends Error {}
class ValueError extends Error {}
class ArithmeticError extends Error {}
class DivisionByZeroError extends ArithmeticError {}
class AssertionError extends Error {}
class CompileError extends Error {}
class ParseError extends CompileError {}
class ArgumentCountError extends TypeError {}
class UnhandledMatchError extends Error {}
class LogicException extends Exception {}
class BadFunctionCallException extends LogicException {}
class BadMethodCallException extends BadFunctionCallException {}
class DomainException extends LogicException {}
class InvalidArgumentException extends LogicException {}
class LengthException extends LogicException {}
class OutOfRangeException extends LogicException {}
class RuntimeException extends Exception {}
class OutOfBoundsException extends RuntimeException {}
class OverflowException extends RuntimeException {}
class RangeException extends RuntimeException {}
class UnderflowException extends RuntimeException {}
class UnexpectedValueException extends RuntimeException {}
class JsonException extends Exception {}
class Random\RandomException extends Exception {}
