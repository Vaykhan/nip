# NIP — Nip is php

`nip.js` is a self-contained PHP interpreter written in plain Node.js (no npm dependencies,
Node ≥ 18; developed and tested on Node 22). It targets PHP 8.3 semantics and is checked
differentially against the real `php` binary.

```sh
node nip.js script.php arg1 arg2      # run a script ($argv / $argc populated)
node nip.js -r 'echo PHP_VERSION;'    # run code
echo '<?php echo 1+1;' | node nip.js  # read script from stdin
node nip.js -l script.php             # syntax check
node nip.js -d precision=17 file.php  # set ini values
```

Embedding:

```js
const php = require('./nip.js');
const { output, exitCode } = php.run('<?php echo "hi";');      // captured output
php.runFile('script.php', { argv: ['script.php'], capture: false });
```

## How it works

Lexer → recursive-descent/Pratt parser → AST → closure compiler (each AST node becomes a JS
closure; generator functions compile to JS generator functions) → execution. Strings are PHP
byte strings, integers are 64-bit (JS numbers with a BigInt fallback beyond 2^53), floats are
boxed so `1.0` and `1` stay distinct, and arrays are ordered hash maps with copy-on-write and a
packed-list fast path. Scripts run in a worker thread with a 256 MB stack so deep recursion
(~200k frames) works.

## What's supported

- **Language:** everything commonly used in PHP 8.3 — classes, interfaces, traits (`insteadof`/`as`),
  abstract/final, readonly properties and classes, constructor promotion, enums (pure and
  backed, with methods, constants and interfaces), `match`, closures and arrow functions,
  first-class callables (`strlen(...)`), named arguments, spread/unpacking, nullsafe `?->`,
  generators (`yield`, keys, `send`, `throw`, `yield from`, return values), references
  (including return-by-reference), static variables, late static binding, magic methods
  (`__get`/`__set`/`__isset`/`__unset`/`__call`/`__callStatic`/`__invoke`/`__toString`/`__clone`/
  `__debugInfo`/`__serialize`/`__unserialize`/`__sleep`/`__wakeup`), destructors with
  PHP-like timing, typed parameters/returns/properties with coercive and strict mode, union,
  intersection and nullable types, exceptions with `finally`, namespaces and `use`, `include`/
  `require`, `eval`, heredoc/nowdoc, alternative control syntax, inline HTML.
- **Library:** about 600 functions — strings, multibyte (`mb_*`), arrays and sorting, math,
  `sprintf` family, PCRE (`preg_*`, translated to JS regexes), JSON, `serialize`, `var_dump`/
  `print_r`/`var_export`, dates (`date`, `strtotime`, `mktime`, time zones via ICU,
  `DateTime`/`DateTimeImmutable`/`DateInterval`/`DatePeriod`), files and streams (`fopen`,
  `fgets`, `STDIN`, `php://memory`, `file_get_contents`, `glob`, ...), output buffering, error
  handlers, `filter_var`, hashing (`md5`, `sha1`, `hash`, `hash_hmac`, `crc32`), `password_hash`/`password_verify`/`crypt`
  (real bcrypt, MD5- and SHA-crypt, interoperable with PHP), `sscanf`, random
  (`mt_rand` compatible with PHP's Mersenne Twister when seeded), process execution.
- **SPL:** `ArrayObject`, `ArrayIterator`, `SplStack`/`SplQueue`/`SplDoublyLinkedList`, heaps,
  `SplPriorityQueue`, `SplFixedArray`, `SplObjectStorage`, `WeakMap`, and the common iterators.
- **Diagnostics:** warnings, notices and uncaught errors use PHP's messages and format
  (`PHP Warning:  ... in file on line N` on stderr, stack traces).

## Testing

`tests/` holds differential tests compared line-for-line with the reference `php` binary:

```sh
tests/run.sh                                         # 17 feature suites, all passing
node tests/phpt/runner.js /path/to/php-src/tests/lang # run php-src .phpt files
```

Both need the reference `php` binary on `PATH`. `tests/phpt/runner.js` runs the `--FILE--` section of each php-src `.phpt` test with both the
reference `php` 8.3.6 and NIP and requires identical output and exit code. Results against
php-src 8.3.6's test suite (tests that need extensions, CGI, or special SAPIs are skipped):

| Suite | Identical output |
|---|---|
| `tests/lang` | 255 / 278 (92%) |
| `ext/standard/tests/math` | 121 / 148 (82%) |
| `ext/standard/tests/array` | 598 / 795 (75%) |
| `ext/json/tests` | 62 / 85 (73%) |
| `ext/standard/tests/strings` | 441 / 634 (70%) |
| `ext/pcre/tests` | 90 / 148 (61%) |
| `Zend/tests` (engine edge cases) | 2019 / 3774 (53%) |

Most remaining differences fall into a few groups: compile-time diagnostics for *invalid* code,
object handle numbers (`#3` vs `#1`, since PHP reuses freed handles), engine internals (GC,
memory limits, opcache), and PCRE features JavaScript regexes lack.

## Known limitations

- Not implemented: `goto`, property hooks (8.4), Fibers, Reflection, `declare(ticks)`, network
  streams/sockets (HTTP via `file_get_contents` shells out to `curl`), `php_user_filter`,
  `ext/intl`, `mysqli`/PDO and other database extensions, GD, sessions, a web SAPI.
- Many compile-time errors PHP reports for invalid code (duplicate modifiers, bad
  inheritance signatures, ...) are not detected; valid programs are unaffected.
- Regex: possessive quantifiers and atomic groups are approximated; recursion `(?R)`,
  conditionals `(?(1)...)`, `\K` and duplicate group names `(?J)` aren't supported.
- Object handle IDs (`#N` in `var_dump`) increase monotonically; PHP reuses freed IDs.
- Performance: about 1.5× slower than PHP 8.3 on array/string/object-heavy loops and about 5×
  slower on call-heavy recursion (e.g. naive `fib`); startup is ~110 ms (PHP: ~20 ms).

## License

BSD 3-Clause — see [LICENSE](LICENSE).
