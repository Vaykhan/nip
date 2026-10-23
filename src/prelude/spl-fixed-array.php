<?php
class SplFixedArray implements IteratorAggregate, ArrayAccess, Countable, JsonSerializable {
  private $__d = []; private $__n = 0;
  public function __construct(int $size = 0) { if ($size < 0) throw new ValueError("SplFixedArray::__construct(): Argument #1 (\$size) must be greater than or equal to 0"); $this->__n = $size; $this->__d = $size ? array_fill(0, $size, null) : []; }
  public static function fromArray($array, bool $preserveKeys = true) { $n = $array ? ($preserveKeys ? max(array_keys($array)) + 1 : count($array)) : 0; $f = new SplFixedArray($n); $i = 0; foreach ($array as $k => $v) { $f[$preserveKeys ? $k : $i++] = $v; } return $f; }
  public function toArray() { return $this->__d; }
  public function getSize() { return $this->__n; }
  public function setSize(int $size) { if ($size < $this->__n) $this->__d = array_slice($this->__d, 0, $size); else for ($i = $this->__n; $i < $size; $i++) $this->__d[$i] = null; $this->__n = $size; return true; }
  public function count(): int { return $this->__n; }
  private function __chk($i) { if (!is_int($i) && !(is_string($i) && is_numeric($i)) && !is_float($i) && !is_bool($i)) throw new TypeError("Cannot access offset of type " . get_debug_type($i) . " on SplFixedArray"); $i = (int)$i; if ($i < 0 || $i >= $this->__n) throw new RuntimeException("Index invalid or out of range"); return $i; }
  public function offsetExists($index): bool { return is_numeric($index) && $index >= 0 && $index < $this->__n && $this->__d[(int)$index] !== null; }
  public function offsetGet($index): mixed { return $this->__d[$this->__chk($index)]; }
  public function offsetSet($index, $value): void { if ($index === null) throw new RuntimeException("[] operator not supported for SplFixedArray"); $this->__d[$this->__chk($index)] = $value; }
  public function offsetUnset($index): void { $this->__d[$this->__chk($index)] = null; }
  public function getIterator(): Iterator { return new ArrayIterator($this->__d); }
  public function jsonSerialize(): array { return $this->__d; }
  public function __wakeup() {}
}