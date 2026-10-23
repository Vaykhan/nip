<?php
class IteratorIterator implements OuterIterator {
  protected $__it;
  public function __construct(Traversable $iterator, ?string $class = null) { $this->__it = $iterator instanceof IteratorAggregate ? $iterator->getIterator() : $iterator; }
  public function getInnerIterator(): ?Iterator { return $this->__it; }
  public function rewind(): void { $this->__it->rewind(); }
  public function valid(): bool { return $this->__it->valid(); }
  public function current(): mixed { return $this->__it->current(); }
  public function key(): mixed { return $this->__it->key(); }
  public function next(): void { $this->__it->next(); }
}
abstract class FilterIterator extends IteratorIterator {
  abstract public function accept(): bool;
  public function rewind(): void { parent::rewind(); $this->__fetch(); }
  public function next(): void { parent::next(); $this->__fetch(); }
  private function __fetch() { while (parent::valid() && !$this->accept()) parent::next(); }
}
class CallbackFilterIterator extends FilterIterator {
  private $__cb;
  public function __construct(Iterator $iterator, callable $callback) { parent::__construct($iterator); $this->__cb = $callback; }
  public function accept(): bool { return (bool)($this->__cb)($this->current(), $this->key(), $this->__it); }
}
class LimitIterator extends IteratorIterator {
  private $__off; private $__lim; private $__pos = 0;
  public function __construct(Iterator $iterator, int $offset = 0, int $limit = -1) { parent::__construct($iterator); $this->__off = $offset; $this->__lim = $limit; }
  public function rewind(): void { parent::rewind(); $this->__pos = 0; for ($i = 0; $i < $this->__off && parent::valid(); $i++) { parent::next(); $this->__pos++; } }
  public function valid(): bool { return ($this->__lim === -1 || $this->__pos < $this->__off + $this->__lim) && parent::valid(); }
  public function next(): void { parent::next(); $this->__pos++; }
  public function getPosition(): int { return $this->__pos; }
}
class InfiniteIterator extends IteratorIterator {
  public function next(): void { parent::next(); if (!parent::valid()) parent::rewind(); }
}
class NoRewindIterator extends IteratorIterator {
  private $__started = false;
  public function rewind(): void { if (!$this->__started) { $this->__started = true; } }
}
class AppendIterator extends IteratorIterator {
  private $__its = []; private $__idx = 0;
  public function __construct() {}
  public function append(Iterator $iterator): void { $this->__its[] = $iterator; if (count($this->__its) === 1) { $this->__idx = 0; $this->__it = $iterator; $iterator->rewind(); } }
  public function rewind(): void { $this->__idx = 0; if ($this->__its) { $this->__it = $this->__its[0]; $this->__it->rewind(); $this->__skip(); } }
  public function valid(): bool { return $this->__it !== null && $this->__idx < count($this->__its) && $this->__it->valid(); }
  public function next(): void { if (!$this->__it) return; $this->__it->next(); $this->__skip(); }
  private function __skip() { while (!$this->__it->valid() && $this->__idx < count($this->__its) - 1) { $this->__idx++; $this->__it = $this->__its[$this->__idx]; $this->__it->rewind(); } }
  public function getIteratorIndex() { return $this->__idx; }
}