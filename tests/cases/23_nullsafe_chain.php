<?php
// nullsafe short-circuiting: the rest of the chain is skipped
class Foo {
    public $bar = null;
    function self() { return $this; }
    function none() { return null; }
}
$a = null;
var_dump($a?->b->c);
var_dump($a?->b['x']);
var_dump($a?->b->c());
var_dump($a?->b(print('not evaluated')));
var_dump(isset($a?->b->c));
var_dump($a?->b->c ?? 'default');
$foo = new Foo();
var_dump($foo->none()?->x->y);
var_dump($foo->self()?->bar);
var_dump($foo?->self()->none()?->z);
function f(): ?Foo { return null; }
var_dump(f()?->self()->self());
