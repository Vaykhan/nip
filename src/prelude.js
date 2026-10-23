// Loader for the PHP-source part of the standard library (src/prelude/*.php).
//
// core.php (interfaces, exceptions, ...) is compiled at boot. Every other file is lazy: it is
// compiled the first time one of the classes or functions it declares is looked up.

import fs from 'node:fs';
import { PHPArray } from './values.js';
import { traceAsString } from './runtime/errors.js';
import { def } from './lib/core.js';

export const PRELUDE_CORE = 'core.php';
export const PRELUDE_LAZY = [
  'array-iterator.php', 'array-object.php', 'spl-doubly-linked-list.php', 'spl-heap.php', 'spl-priority-queue.php',
  'spl-fixed-array.php', 'spl-object-storage.php', 'weak-map.php', 'iterators.php', 'misc-iterators.php',
  'recursive-iterators.php', 'datetime.php', 'reflection.php',
];

const PRELUDE_DIR = new URL('./prelude/', import.meta.url);
export function readPrelude(name) { return fs.readFileSync(new URL(name, PRELUDE_DIR), 'latin1'); }

function exceptionTrace(obj) { return obj.trace || new PHPArray(); }
def('__exception_trace', (e) => exceptionTrace(e));
def('__exception_trace_string', (e) => traceAsString(exceptionTrace(e)));
