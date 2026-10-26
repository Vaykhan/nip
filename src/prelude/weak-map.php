<?php
final class WeakMap implements ArrayAccess, Countable, IteratorAggregate {
  private $__o = []; private $__v = [];
  private static function __key($object, $append = false) { if ($object === null && $append) throw new Error("Cannot append to WeakMap"); if (!is_object($object)) throw new TypeError("WeakMap key must be an object"); return spl_object_id($object); }
  public function offsetExists($object): bool { return isset($this->__o[self::__key($object)]); }
  public function offsetGet($object): mixed { $h = self::__key($object, true); if (!isset($this->__o[$h])) throw new Error("Object " . get_class($object) . "#" . $h . " not contained in WeakMap"); return $this->__v[$h]; }
  public function offsetSet($object, $value): void { $h = self::__key($object, true); $this->__o[$h] = $object; $this->__v[$h] = $value; }
  public function offsetUnset($object): void { $h = self::__key($object); unset($this->__o[$h], $this->__v[$h]); }
  public function count(): int { return count($this->__o); }
  public function getIterator(): Iterator { $f = function () { foreach ($this->__o as $h => $o) yield $o => $this->__v[$h]; }; return $f(); }
}