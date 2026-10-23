<?php
class ArrayIterator implements SeekableIterator, ArrayAccess, Countable, Serializable {
  private $__a; private $__k = []; private $__i = 0;
  public function __construct($array = [], int $flags = 0) { $this->__a = is_object($array) ? get_object_vars($array) : $array; $this->__k = array_keys($this->__a); }
  public function current(): mixed { return $this->valid() ? $this->__a[$this->__k[$this->__i]] : null; }
  public function key(): mixed { return $this->__k[$this->__i] ?? null; }
  public function next(): void { $this->__i++; }
  public function rewind(): void { $this->__k = array_keys($this->__a); $this->__i = 0; }
  public function valid(): bool { return $this->__i < count($this->__k); }
  public function seek(int $offset): void { if ($offset < 0 || $offset >= count($this->__k)) throw new OutOfBoundsException("Seek position $offset is out of range"); $this->__i = $offset; }
  public function count(): int { return count($this->__a); }
  public function offsetExists($key): bool { return isset($this->__a[$key]); }
  public function offsetGet($key): mixed { return $this->__a[$key]; }
  public function offsetSet($key, $value): void { if ($key === null) $this->__a[] = $value; else $this->__a[$key] = $value; }
  public function offsetUnset($key): void { unset($this->__a[$key]); }
  public function getArrayCopy(): array { return $this->__a; }
  public function append($value): void { $this->__a[] = $value; }
  public function asort(int $flags = SORT_REGULAR) { asort($this->__a, $flags); return true; }
  public function ksort(int $flags = SORT_REGULAR) { ksort($this->__a, $flags); return true; }
  public function uasort($callback) { uasort($this->__a, $callback); return true; }
  public function uksort($callback) { uksort($this->__a, $callback); return true; }
  public function getFlags() { return 0; }
  public function setFlags($flags) {}
  public function serialize() { return serialize($this->__a); }
  public function unserialize($data) { $this->__a = unserialize($data); }
  public function __serialize(): array { return $this->__a; }
  public function __unserialize(array $data): void { $this->__a = $data; }
  public function __debugInfo() { return ["\0ArrayIterator\0storage" => $this->__a]; }
}
class RecursiveArrayIterator extends ArrayIterator {
  public function hasChildren(): bool { $c = $this->current(); return is_array($c) || is_object($c); }
  public function getChildren(): ?RecursiveArrayIterator { return new RecursiveArrayIterator($this->current()); }
}