<?php
interface RecursiveIterator extends Iterator { public function hasChildren(): bool; public function getChildren(): ?RecursiveIterator; }
class RecursiveIteratorIterator implements OuterIterator {
  const LEAVES_ONLY = 0; const SELF_FIRST = 1; const CHILD_FIRST = 2; const CATCH_GET_CHILD = 16;
  private $__root; private $__mode; private $__items = []; private $__i = 0; private $__maxDepth = -1;
  public function __construct($iterator, int $mode = self::LEAVES_ONLY, int $flags = 0) { $this->__root = $iterator instanceof IteratorAggregate ? $iterator->getIterator() : $iterator; $this->__mode = $mode; }
  private function __collect($it, $depth) {
    for ($it->rewind(); $it->valid(); $it->next()) {
      $k = $it->key(); $v = $it->current();
      $has = $it->hasChildren() && ($this->__maxDepth < 0 || $depth < $this->__maxDepth);
      if ($has) {
        if ($this->__mode === 1) $this->__items[] = [$k, $v, $depth];
        $this->__collect($it->getChildren(), $depth + 1);
        if ($this->__mode === 2) $this->__items[] = [$k, $v, $depth];
      } else $this->__items[] = [$k, $v, $depth];
    }
  }
  public function rewind(): void { $this->__items = []; $this->__i = 0; $this->__collect($this->__root, 0); }
  public function valid(): bool { return $this->__i < count($this->__items); }
  public function key(): mixed { return $this->__items[$this->__i][0] ?? null; }
  public function current(): mixed { return $this->__items[$this->__i][1] ?? null; }
  public function next(): void { $this->__i++; }
  public function getDepth() { return $this->__items[$this->__i][2] ?? 0; }
  public function setMaxDepth(int $maxDepth = -1): void { $this->__maxDepth = $maxDepth; }
  public function getMaxDepth() { return $this->__maxDepth < 0 ? false : $this->__maxDepth; }
  public function getInnerIterator(): ?Iterator { return $this->__root; }
}
class CachingIterator extends IteratorIterator {
  const CALL_TOSTRING = 1; const FULL_CACHE = 256;
  private $__cur; private $__key; private $__has = false;
  public function rewind(): void { parent::rewind(); $this->__fetch(); }
  private function __fetch() { $this->__has = parent::valid(); if ($this->__has) { $this->__cur = parent::current(); $this->__key = parent::key(); parent::next(); } }
  public function valid(): bool { return $this->__has; }
  public function current(): mixed { return $this->__cur; }
  public function key(): mixed { return $this->__key; }
  public function next(): void { $this->__fetch(); }
  public function hasNext() { return parent::valid(); }
}
