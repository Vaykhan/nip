<?php
abstract class SplHeap implements Iterator, Countable {
  private $__h = [];
  abstract protected function compare($value1, $value2);
  public function insert($value) { $h = &$this->__h; $h[] = $value; $i = count($h) - 1; while ($i > 0) { $p = ($i - 1) >> 1; if ($this->compare($h[$i], $h[$p]) > 0) { [$h[$i], $h[$p]] = [$h[$p], $h[$i]]; $i = $p; } else break; } return true; }
  public function extract() {
    $h = &$this->__h;
    if (!$h) throw new RuntimeException("Can't extract from an empty heap");
    $top = $h[0]; $last = array_pop($h);
    if ($h) { $h[0] = $last; $n = count($h); $i = 0;
      while (true) { $l = 2 * $i + 1; $r = $l + 1; $m = $i;
        if ($l < $n && $this->compare($h[$l], $h[$m]) > 0) $m = $l;
        if ($r < $n && $this->compare($h[$r], $h[$m]) > 0) $m = $r;
        if ($m === $i) break;
        [$h[$i], $h[$m]] = [$h[$m], $h[$i]]; $i = $m; } }
    return $top;
  }
  public function top() { if (!$this->__h) throw new RuntimeException("Can't peek at an empty heap"); return $this->__h[0]; }
  public function isEmpty() { return !$this->__h; }
  public function count(): int { return count($this->__h); }
  public function rewind(): void {}
  public function valid(): bool { return count($this->__h) > 0; }
  public function current(): mixed { return $this->__h ? $this->__h[0] : null; }
  public function key(): mixed { return count($this->__h) - 1; }
  public function next(): void { if ($this->__h) $this->extract(); }
  public function recoverFromCorruption() { return true; }
  public function isCorrupted() { return false; }
  public function __debugInfo() { return ["\0SplHeap\0flags" => 0, "\0SplHeap\0isCorrupted" => false, "\0SplHeap\0heap" => $this->__h]; }
}
class SplMinHeap extends SplHeap { protected function compare($value1, $value2) { return $value2 <=> $value1; } }
class SplMaxHeap extends SplHeap { protected function compare($value1, $value2) { return $value1 <=> $value2; } }