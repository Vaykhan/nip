<?php
class SplObjectStorage implements Countable, Iterator, ArrayAccess {
  private $__o = []; private $__dt = []; private $__i = 0;
  public function attach(object $object, mixed $info = null): void { $h = spl_object_id($object); $this->__o[$h] = $object; $this->__dt[$h] = $info; }
  public function detach(object $object): void { $h = spl_object_id($object); unset($this->__o[$h], $this->__dt[$h]); }
  public function contains(object $object): bool { return isset($this->__o[spl_object_id($object)]); }
  public function addAll(SplObjectStorage $storage) { foreach ($storage->__o as $h => $o) { $this->__o[$h] = $o; $this->__dt[$h] = $storage->__dt[$h]; } return count($this->__o); }
  public function removeAll(SplObjectStorage $storage) { foreach ($storage->__o as $h => $o) unset($this->__o[$h], $this->__dt[$h]); return count($this->__o); }
  public function removeAllExcept(SplObjectStorage $storage) { foreach ($this->__o as $h => $o) if (!isset($storage->__o[$h])) unset($this->__o[$h], $this->__dt[$h]); return count($this->__o); }
  public function getInfo(): mixed { $k = array_keys($this->__o); return isset($k[$this->__i]) ? $this->__dt[$k[$this->__i]] : null; }
  public function setInfo(mixed $info): void { $k = array_keys($this->__o); if (isset($k[$this->__i])) $this->__dt[$k[$this->__i]] = $info; }
  public function getHash(object $object): string { return spl_object_hash($object); }
  public function count(int $mode = COUNT_NORMAL): int { return count($this->__o); }
  public function rewind(): void { $this->__i = 0; }
  public function valid(): bool { return $this->__i < count($this->__o); }
  public function key(): mixed { return $this->__i; }
  public function current(): mixed { $k = array_keys($this->__o); return isset($k[$this->__i]) ? $this->__o[$k[$this->__i]] : null; }
  public function next(): void { $this->__i++; }
  public function offsetExists($object): bool { return $this->contains($object); }
  public function offsetGet($object): mixed { $h = spl_object_id($object); if (!isset($this->__o[$h])) throw new UnexpectedValueException("Object not found"); return $this->__dt[$h]; }
  public function offsetSet($object, $info = null): void { $this->attach($object, $info); }
  public function offsetUnset($object): void { $this->detach($object); }
  public function __debugInfo() { $s = []; foreach ($this->__o as $h => $o) $s[] = ['obj' => $o, 'inf' => $this->__dt[$h]]; return ["\0SplObjectStorage\0storage" => $s]; }
}