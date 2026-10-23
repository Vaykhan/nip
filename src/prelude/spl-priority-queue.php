<?php
class SplPriorityQueue implements Iterator, Countable {
  const EXTR_DATA = 1; const EXTR_PRIORITY = 2; const EXTR_BOTH = 3;
  private $__h = []; private $__serial = PHP_INT_MAX; private $__flags = 1;
  public function compare($priority1, $priority2) { return $priority1 <=> $priority2; }
  private function __cmp($a, $b) { $c = $this->compare($a[1], $b[1]); return $c !== 0 ? $c : $a[2] <=> $b[2]; }
  public function insert($value, $priority) { $h = &$this->__h; $h[] = [$value, $priority, $this->__serial--]; $i = count($h) - 1; while ($i > 0) { $p = ($i - 1) >> 1; if ($this->__cmp($h[$i], $h[$p]) > 0) { [$h[$i], $h[$p]] = [$h[$p], $h[$i]]; $i = $p; } else break; } return true; }
  private function __fmt($e) { if ($this->__flags === 3) return ['data' => $e[0], 'priority' => $e[1]]; if ($this->__flags === 2) return $e[1]; return $e[0]; }
  public function extract() {
    $h = &$this->__h;
    if (!$h) throw new RuntimeException("Can't extract from an empty heap");
    $top = $h[0]; $last = array_pop($h);
    if ($h) { $h[0] = $last; $n = count($h); $i = 0;
      while (true) { $l = 2 * $i + 1; $r = $l + 1; $m = $i;
        if ($l < $n && $this->__cmp($h[$l], $h[$m]) > 0) $m = $l;
        if ($r < $n && $this->__cmp($h[$r], $h[$m]) > 0) $m = $r;
        if ($m === $i) break;
        [$h[$i], $h[$m]] = [$h[$m], $h[$i]]; $i = $m; } }
    return $this->__fmt($top);
  }
  public function top() { if (!$this->__h) throw new RuntimeException("Can't peek at an empty heap"); return $this->__fmt($this->__h[0]); }
  public function setExtractFlags(int $flags) { $this->__flags = $flags; return $flags; }
  public function getExtractFlags() { return $this->__flags; }
  public function isEmpty() { return !$this->__h; }
  public function count(): int { return count($this->__h); }
  public function rewind(): void {}
  public function valid(): bool { return count($this->__h) > 0; }
  public function current(): mixed { return $this->__h ? $this->__fmt($this->__h[0]) : null; }
  public function key(): mixed { return count($this->__h) - 1; }
  public function next(): void { if ($this->__h) $this->extract(); }
  public function toArray() { $c = clone $this; $o = []; while ($c->valid()) { $o[] = $c->extract(); } return $o; }
  public function recoverFromCorruption() { return true; }
  public function isCorrupted() { return false; }
}