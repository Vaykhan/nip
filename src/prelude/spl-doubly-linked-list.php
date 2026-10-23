<?php
class SplDoublyLinkedList implements Iterator, Countable, ArrayAccess, Serializable {
  const IT_MODE_LIFO = 2; const IT_MODE_FIFO = 0; const IT_MODE_DELETE = 1; const IT_MODE_KEEP = 0;
  protected $__d = []; protected $__i = 0; protected $__mode = 0;
  public function push($value) { $this->__d[] = $value; }
  public function pop() { if (!$this->__d) throw new RuntimeException("Can't pop from an empty datastructure"); return array_pop($this->__d); }
  public function shift() { if (!$this->__d) throw new RuntimeException("Can't shift from an empty datastructure"); return array_shift($this->__d); }
  public function unshift($value) { array_unshift($this->__d, $value); }
  public function top() { if (!$this->__d) throw new RuntimeException("Can't peek at an empty datastructure"); return $this->__d[count($this->__d) - 1]; }
  public function bottom() { if (!$this->__d) throw new RuntimeException("Can't peek at an empty datastructure"); return $this->__d[0]; }
  public function isEmpty() { return !$this->__d; }
  public function count(): int { return count($this->__d); }
  public function toArray() { return $this->__d; }
  public function setIteratorMode(int $mode) { $this->__mode = $mode; return 0; }
  public function getIteratorMode() { return $this->__mode; }
  public function offsetExists($index): bool { return $index >= 0 && $index < count($this->__d); }
  public function offsetGet($index): mixed { if ($index < 0 || $index >= count($this->__d)) throw new OutOfRangeException("SplDoublyLinkedList::offsetGet(): Argument #1 (\$index) is out of range"); return $this->__d[$index]; }
  public function offsetSet($index, $value): void { if ($index === null) $this->__d[] = $value; else { if ($index < 0 || $index >= count($this->__d)) throw new OutOfRangeException("SplDoublyLinkedList::offsetSet(): Argument #1 (\$index) is out of range"); $this->__d[$index] = $value; } }
  public function offsetUnset($index): void { if ($index < 0 || $index >= count($this->__d)) throw new OutOfRangeException("SplDoublyLinkedList::offsetUnset(): Argument #1 (\$index) is out of range"); array_splice($this->__d, $index, 1); }
  public function add($index, $value) { array_splice($this->__d, $index, 0, [$value]); }
  public function rewind(): void { $this->__i = ($this->__mode & 2) ? count($this->__d) - 1 : 0; }
  public function valid(): bool { return $this->__i >= 0 && $this->__i < count($this->__d); }
  public function current(): mixed { return $this->__d[$this->__i] ?? null; }
  public function key(): mixed { return $this->__i; }
  public function next(): void {
    if ($this->__mode & 1) { if ($this->__mode & 2) { array_pop($this->__d); $this->__i = count($this->__d) - 1; } else { array_shift($this->__d); } }
    else { $this->__i += ($this->__mode & 2) ? -1 : 1; }
  }
  public function prev(): void { $this->__i += ($this->__mode & 2) ? 1 : -1; }
  public function serialize() { return serialize($this->__d); }
  public function unserialize($data) { $this->__d = unserialize($data); }
  public function __serialize(): array { return [$this->__mode, $this->__d, []]; }
  public function __unserialize(array $data): void { [$this->__mode, $this->__d] = $data; }
  public function __debugInfo() { return ["\0SplDoublyLinkedList\0flags" => $this->__mode, "\0SplDoublyLinkedList\0dllist" => $this->__d]; }
}
class SplQueue extends SplDoublyLinkedList {
  public function enqueue($value) { $this->push($value); }
  public function dequeue() { return $this->shift(); }
}
class SplStack extends SplDoublyLinkedList {
  protected $__mode = 2;
  public function setIteratorMode(int $mode) { $this->__mode = $mode | 2; return 0; }
}