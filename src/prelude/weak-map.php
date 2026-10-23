<?php
final class WeakMap implements ArrayAccess, Countable, IteratorAggregate {
  private $__o = []; private $__v = [];
  public function offsetExists($object): bool { return isset($this->__o[spl_object_id($object)]); }
  public function offsetGet($object): mixed { $h = spl_object_id($object); if (!isset($this->__o[$h])) throw new Error("Object " . get_class($object) . "#" . $h . " not contained in WeakMap"); return $this->__v[$h]; }
  public function offsetSet($object, $value): void { $h = spl_object_id($object); $this->__o[$h] = $object; $this->__v[$h] = $value; }
  public function offsetUnset($object): void { $h = spl_object_id($object); unset($this->__o[$h], $this->__v[$h]); }
  public function count(): int { return count($this->__o); }
  public function getIterator(): Iterator { $f = function () { foreach ($this->__o as $h => $o) yield $o => $this->__v[$h]; }; return $f(); }
}