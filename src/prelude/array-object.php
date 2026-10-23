<?php
class ArrayObject implements IteratorAggregate, ArrayAccess, Countable, Serializable {
  const STD_PROP_LIST = 1; const ARRAY_AS_PROPS = 2;
  private $__a;
  public function __construct($array = [], int $flags = 0, string $iteratorClass = "ArrayIterator") { $this->__a = is_object($array) ? get_object_vars($array) : $array; }
  public function getIterator(): Iterator { return new ArrayIterator($this->__a); }
  public function count(): int { return count($this->__a); }
  public function offsetExists($key): bool { return isset($this->__a[$key]); }
  public function offsetGet($key): mixed { return $this->__a[$key]; }
  public function offsetSet($key, $value): void { if ($key === null) $this->__a[] = $value; else $this->__a[$key] = $value; }
  public function offsetUnset($key): void { unset($this->__a[$key]); }
  public function getArrayCopy(): array { return $this->__a; }
  public function exchangeArray($array) { $old = $this->__a; $this->__a = $array; return $old; }
  public function append($value): void { $this->__a[] = $value; }
  public function asort(int $flags = SORT_REGULAR) { asort($this->__a, $flags); return true; }
  public function ksort(int $flags = SORT_REGULAR) { ksort($this->__a, $flags); return true; }
  public function uasort($callback) { uasort($this->__a, $callback); return true; }
  public function uksort($callback) { uksort($this->__a, $callback); return true; }
  public function serialize() { return serialize($this->__a); }
  public function unserialize($data) { $this->__a = unserialize($data); }
  public function __serialize(): array { return $this->__a; }
  public function __unserialize(array $data): void { $this->__a = $data; }
  public function __debugInfo() { return ["\0ArrayObject\0storage" => $this->__a]; }
}