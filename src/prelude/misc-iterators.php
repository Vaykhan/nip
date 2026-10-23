<?php
class MultipleIterator implements Iterator {
  const MIT_NEED_ANY = 0; const MIT_NEED_ALL = 1; const MIT_KEYS_NUMERIC = 0; const MIT_KEYS_ASSOC = 2;
  private $__its = []; private $__flags;
  public function __construct(int $flags = 1) { $this->__flags = $flags; }
  public function attachIterator(Iterator $iterator, $info = null) { $this->__its[] = [$iterator, $info]; }
  public function countIterators() { return count($this->__its); }
  public function rewind(): void { foreach ($this->__its as [$it]) $it->rewind(); }
  public function valid(): bool { if (!$this->__its) return false; $any = false; $all = true; foreach ($this->__its as [$it]) { if ($it->valid()) $any = true; else $all = false; } return ($this->__flags & 1) ? $all : $any; }
  public function next(): void { foreach ($this->__its as [$it]) $it->next(); }
  public function current(): mixed { $r = []; foreach ($this->__its as $i => [$it, $info]) { $k = ($this->__flags & 2) ? $info : $i; $r[$k] = $it->valid() ? $it->current() : null; } return $r; }
  public function key(): mixed { $r = []; foreach ($this->__its as $i => [$it, $info]) { $k = ($this->__flags & 2) ? $info : $i; $r[$k] = $it->valid() ? $it->key() : null; } return $r; }
}
class EmptyIterator implements Iterator {
  public function current(): never { throw new BadMethodCallException("Accessing the value of an EmptyIterator"); }
  public function key(): never { throw new BadMethodCallException("Accessing the key of an EmptyIterator"); }
  public function next(): void {} public function rewind(): void {} public function valid(): bool { return false; }
}