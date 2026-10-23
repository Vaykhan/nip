<?php
class ArrayIterator implements SeekableIterator, ArrayAccess, Countable, Serializable {
  const STD_PROP_LIST = 1; const ARRAY_AS_PROPS = 2;
  private $__a; private $__k = []; private $__i = 0; private $__f = 0;
  public function __construct($array = [], int $flags = 0) { $this->__a = is_object($array) ? get_object_vars($array) : $array; $this->__k = array_keys($this->__a); $this->__f = $flags; }
  // ARRAY_AS_PROPS: undefined properties are array entries
  public function __nipGet($n) { return $this->__f & 2 ? [true, $this->__a[$n]] : null; }
  public function __nipIsset($n) { return $this->__f & 2 ? [true, $this->__a[$n] ?? null] : null; }
  public function __nipSet($n, $v) { if ($this->__f & 2) { $this->__a[$n] = $v; return [true, null]; } return null; }
  public function __nipUnset($n) { if ($this->__f & 2) { unset($this->__a[$n]); return [true, null]; } return null; }
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
  public function getFlags() { return $this->__f; }
  public function setFlags($flags) { $this->__f = $flags; }
  public function serialize() { return serialize($this->__a); }
  public function unserialize($data) { $this->__a = unserialize($data); }
  public function __serialize(): array { return $this->__a; }
  public function __unserialize(array $data): void { $this->__a = $data; }
  public function __debugInfo() { return (array) $this + ["\0ArrayIterator\0storage" => $this->__a]; }
}
class RecursiveArrayIterator extends ArrayIterator {
  public function hasChildren(): bool { $c = $this->current(); return is_array($c) || is_object($c); }
  public function getChildren(): ?RecursiveArrayIterator { return new RecursiveArrayIterator($this->current()); }
}