# NIP — Nip is php

```sh
node bin/nip.js script.php arg1 arg2      # run a script ($argv / $argc populated)
node bin/nip.js -r 'echo PHP_VERSION;'    # run code
echo '<?php echo 1+1;' | node bin/nip.js  # read the script from stdin
node bin/nip.js -l script.php             # syntax check
node bin/nip.js -d precision=17 file.php  # set ini values
```

Installed as a package (`npm install -g @vaykhan/nip`, or `npm install github:Vaykhan/nip` for the latest
code), the command is `nip`.

NIP is written in pure JavaScript, with no PHP binary, WebAssembly or dependencies. It checks
its behaviour against the real `php` binary and aims for identical output, including
warnings and error messages. It is **alpha** software: good for running scripts and CLI tools,
not yet for serving web applications. See the [roadmap](ROADMAP.md) for what is missing and the
plan to get there.

## Embedding

```js
import { run, runFile } from '@vaykhan/nip';

const { output, exitCode } = run('<?php echo "hi";');   // output is captured by default
runFile('script.php', { argv: ['script.php', 'x'] });   // output goes to stdout
```

From CommonJS, `require('@vaykhan/nip')` loads the single-file build (`dist/nip.cjs`, created by
`npm run build` or on install). Options: `file`, `argv`, `capture`, `ini` (an object of ini settings).

## What's supported

- **Language:** everything commonly used in PHP 8.3. That includes classes, interfaces, traits
  (`insteadof`/`as`), abstract/final, readonly properties and classes, constructor promotion,
  enums (pure and backed, with methods, constants and interfaces), `match`, closures and arrow
  functions, first-class callables (`strlen(...)`), named arguments, spread/unpacking, nullsafe
  `?->`, and generators (keys, `send`, `throw`, `yield from`, return values). Also references
  (including return-by-reference), static variables, late static binding, all magic methods,
  and destructors with PHP-like timing. Typed parameters, returns and properties work in
  coercive and strict mode, with union, intersection and nullable types. Plus exceptions with
  `finally`, namespaces, `include`/`require`, `eval`, heredoc/nowdoc, alternative syntax and
  inline HTML.
- **Library:** about 600 functions:
  - strings, `mb_*`, arrays and sorting, math, the `sprintf` family
  - PCRE (`preg_*`), JSON, `serialize`, `var_dump`/`print_r`/`var_export`
  - dates (`date`, `strtotime`, time zones, `DateTime` and friends)
  - files and streams, output buffering, error handlers, `filter_var`
  - hashing, `password_hash`/`crypt` (real bcrypt, compatible with PHP), `mt_rand` matching
    PHP's sequence when seeded
- **SPL:** `ArrayObject`, `ArrayIterator`, linked lists, stacks and queues, heaps,
  `SplPriorityQueue`, `SplFixedArray`, `SplObjectStorage`, `WeakMap`, and the common iterators.

## Compatibility

php-src's own `.phpt` tests, run with PHP 8.3.6 and NIP. A test counts as passing only when
the output and exit code are identical. Tests that need extensions, CGI or special SAPIs are
skipped.

| Suite | Identical output |
|---|---|
| `tests/lang` | 255 / 278 (92%) |
| `ext/standard/tests/math` | 121 / 148 (82%) |
| `ext/standard/tests/array` | 598 / 795 (75%) |
| `ext/json/tests` | 62 / 85 (73%) |
| `ext/standard/tests/strings` | 441 / 634 (70%) |
| `ext/pcre/tests` | 90 / 148 (61%) |
| `Zend/tests` (engine edge cases) | 2019 / 3774 (53%) |

### Known limitations

- **Not implemented:**
  - `goto`, Fibers, Reflection, `declare(ticks)`
  - network streams and sockets (HTTP URLs in `file_get_contents` shell out to `curl`)
  - `ext/intl`, PDO/mysqli, GD, sessions
  - a web server interface
- Many compile-time errors PHP reports for *invalid* code (duplicate modifiers, incompatible
  method signatures, ...) are not detected. Valid programs are unaffected.
- Regex: recursion `(?R)`, conditionals, `\K` and `(?J)` are unsupported. Possessive
  quantifiers and atomic groups are approximated.
- Object handle numbers (`#N` in `var_dump`) are never reused; PHP reuses freed ones.
- Performance: about 1.5× slower than PHP 8.3 on array/string/object-heavy loops and about 5×
  slower on call-heavy recursion. Startup takes about 110 ms (PHP: about 20 ms).
- No sandbox: scripts have the same file and process access as the Node.js process.

## Project layout

```
bin/nip.js          CLI entry (runs the interpreter in a worker thread with a large stack)
src/                interpreter sources, one ES module per area
  lexer.js parser.js            source → AST
  compiler/                     AST → JS closures
  runtime/                      calls, classes, errors, generators, boot, ...
  lib/                          builtin functions (string.js, array.js, pcre.js, ...)
  prelude/*.php                 standard library parts written in PHP (exceptions, SPL, DateTime)
scripts/build.js    builds dist/nip.cjs, the whole interpreter as one file
tests/cases/        test scripts with expected output from PHP 8.3
tests/phpt/         runner for php-src's .phpt test suite
bench/              benchmark scripts
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together.

## Development

```sh
npm test               # test cases vs expected output (no PHP needed)
npm run test:bundle    # same, against the single-file build
npm run test:php       # compare directly with your local php
node tests/phpt/runner.js /path/to/php-src/tests/lang   # php-src compatibility run
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

BSD 3-Clause. See [LICENSE](LICENSE).
