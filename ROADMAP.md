# NIP roadmap

Where NIP is today, where it is going, and in what order. Every phase has measurable exit
criteria. "Compatible" always means *identical output to PHP*, checked by tests, not
"close enough".

## Where we are (v0.1)

- PHP 8.3 language core: classes, traits, enums, closures, generators, references, match,
  readonly, named arguments, exceptions, namespaces, include/eval.
- About 600 builtin functions (strings, arrays, math, PCRE, JSON, serialize, dates, files, ...).
- CLI only: no web server integration, no database access.
- Identical output on php-src's own tests (v0.1): `tests/lang` 92%, `ext/standard/tests/strings` 70%,
  `ext/standard/tests/array` 75%, `Zend/tests` 53%. Now: `Zend/tests` 62%, `ext/reflection` 64%
  (see the README).
- Speed: about 1.5× slower than PHP 8.3 on loops, about 5× slower on call-heavy code.
  Startup takes about 110 ms.

**Good for:** running PHP scripts and CLI tools where only Node.js is available, embedding PHP
logic in JS applications, teaching, and developer tooling.
**Not yet for:** serving web applications, frameworks (they need Reflection), or untrusted code
(there is no sandbox).

## Principles

1. **PHP is the specification.** Behaviour is checked against the real `php` binary with
   differential tests. Divergences are bugs.
2. **Zero runtime dependencies.** Development tools may have dependencies; the interpreter may not.
3. **Measure everything.** Compatibility is php-src test pass rates; performance is a tracked
   benchmark suite. Every phase moves a number.
4. **Never regress.** CI fails when a php-src suite's pass count drops below the recorded baseline.

---

## Phase 0: Foundation ✅ done

Make the project safe to change quickly.

- [x] Split the single 10,600-line file into ~45 modules (`src/`), keeping a single-file build
      (`dist/nip.cjs`).
- [x] Deterministic test suite with stored expected output (no PHP needed to run it).
- [x] CI on Node 22/24, plus a differential job against php 8.3 and a weekly php-src run.
- [x] Architecture and contribution docs.
- [x] **Baseline ratchet:** store per-suite php-src pass counts in the repo; CI fails on any drop.
- [x] Unit tests (`node:test`) for the lexer, the parser and value operations (conversions,
      comparison, int overflow), which are hard to cover from PHP scripts.
- [x] ESLint (dev dependency) with a small rule set: no unused variables, no accidental globals,
      no shadowed imports.
- [x] Parser fuzzing: random and mutated PHP inputs must produce a PHP `ParseError` or run.
      They must never cause an internal JS exception.
- [x] Release process: semver, CHANGELOG, `npm publish`, GitHub release with `nip.cjs` attached.

**Exit criteria:** CI green on every PR; php-src baselines enforced; first npm release (0.2.0).
The release workflow is ready; publishing 0.2.0 needs an `NPM_TOKEN` secret and a `v0.2.0` tag.

## Phase 1: Language completeness (PHP 8.3 parity)

Everything a modern framework relies on in the language itself.

- [x] **Reflection**: `ReflectionClass`, `ReflectionMethod`, `ReflectionProperty`,
      `ReflectionFunction`, `ReflectionParameter`, `ReflectionNamedType`/union types,
      `ReflectionEnum`, `ReflectionAttribute`. This is the biggest blocker for Laravel/Symfony
      (dependency injection containers, routing, serializers).
      Done, written in PHP (`src/prelude/reflection.php`) on top of `src/lib/reflection.js`.
      Follow-up: builtin functions have no arginfo yet, so their parameters and return types
      are untyped in Reflection; `__toString()` output is only partly identical.
- [x] **Attributes** at runtime (`#[...]` exposed through Reflection, plus the engine attributes
      `#[\Override]`, `#[\SensitiveParameter]`, `#[\AllowDynamicProperties]`).
- [x] `goto`.
- [x] **Fibers.** They need stackful coroutines, which closures over the JS stack can't provide.
      Each function that may suspend gets a second, generator-mode version compiled on demand,
      used for code running inside a Fiber (`yield*` delegation through calls). Code in that
      mode runs about 4× slower than normal code; code outside fibers is unaffected.
      Follow-up: suspending from callbacks called by builtins (`array_map`, `usort`, ...) or
      from inside a generator is not supported yet; it throws a `FiberError` saying so.
- [x] Compile-time checks PHP does for invalid code: duplicate modifiers, method signature
      compatibility (LSP), invalid `readonly` use, interface/enum rules, `goto` rules, invalid
      type declarations, constant expression rules (`src/compiler/checks.js`,
      `src/runtime/inheritance.js`).
- [x] `declare(ticks)`, `register_tick_function`.
- [ ] Object handle reuse, so `#N` in `var_dump` and `spl_object_id()` match PHP after objects
      are freed. Blocked on exact liveness: the cycle collector's roots don't include values
      held only in JS temporaries, so reusing a handle could give two live objects the same
      `spl_object_id()`. Needs reference counting for objects (or roots for temporaries) first.
- [x] **Own regex engine** (`src/lib/regex.js`): a backtracking matcher with PCRE2 semantics on
      byte strings: recursion, conditionals, `\K`, possessive quantifiers, atomic groups,
      backtracking verbs, branch reset, `(?J)`, exact offsets and PCRE2's error messages.
      Byte-mode patterns whose semantics JS `RegExp` reproduces exactly still run on V8.
      Follow-ups: a `RegExp` fast path for UTF-8 mode, and callouts.
- [ ] Then PHP 8.4 (property hooks, asymmetric visibility, `new` without parentheses,
      `array_find` and friends, lazy objects) and PHP 8.5 (pipe operator `|>`, clone with,
      `array_first`/`array_last`, `#[\NoDiscard]`), behind a `-d nip.php_version=` switch.

**Exit criteria:** `tests/lang` ≥ 99%, `Zend/tests` ≥ 80%, `ext/pcre/tests` ≥ 90%. Reflection
passes the php-src `ext/reflection` suite at ≥ 70%.

## Phase 2: Standard library and extensions

Measured suite by suite with php-src's `ext/*/tests`.

- [ ] Close the gaps in `ext/standard` (strings → 90%, arrays → 90%, math → 95%, file system
      functions, `proc_open`, `stream_*` filters and wrappers).
- [ ] Quick wins that map onto Node built-ins: **bcmath** and **gmp** (BigInt), **zlib**
      (`node:zlib` sync APIs), **ctype**, **iconv**, the **random** extension
      (`Random\Randomizer`, engines), the complete `hash` algorithm list, an **openssl** and
      **sodium** subset (`node:crypto`), and **tokenizer** (`token_get_all` on top of NIP's own
      lexer).
- [ ] **Sync bridge.** PHP is synchronous and Node's network APIs are asynchronous. A helper
      worker performs async I/O while the interpreter thread blocks on `Atomics.wait`. This is
      the base for sockets, HTTP clients, `curl`, database drivers and DNS, and replaces the
      current `curl` shell-out in `file_get_contents`.
- [ ] Network streams on top of the bridge: `fsockopen`, `stream_socket_client/server`,
      `http://`/`https://` wrappers with stream contexts, and the **curl** extension (`curl_*`,
      the most used HTTP client API in PHP code).
- [ ] **intl** subset backed by JS `Intl`: `NumberFormatter`, `IntlDateFormatter`, `Collator`,
      `Normalizer`, `Transliterator` basics.
- [ ] **XML**: SimpleXML, DOM, XMLReader/XMLWriter on a pure-JS XML parser. Large but needed by
      many libraries (feeds, SOAP, config files, PHPUnit).
- [ ] **Phar** and **zip** (needed to run `composer.phar` and `phpunit.phar`).

**Exit criteria:** `composer.phar install` works on a real project. PHPUnit runs its own test
suite under NIP.

## Phase 3: Web runtime

What "production use for web apps" requires.

- [ ] **SAPI layer**: map an HTTP request onto `$_GET`, `$_POST`, `$_COOKIE`, `$_FILES`,
      `$_SERVER`, `$_REQUEST` and `php://input`; support `header()`, `setcookie()`,
      `http_response_code()`, `headers_sent()`, output streaming and `flush()`. Multipart
      uploads should follow PHP's limits and ini settings.
- [ ] **`nip serve`**: a built-in server like `php -S`, with router-script support and static
      files.
- [ ] **Request isolation and concurrency**: a pool of workers, each booting once. Per-request
      runtime reset already exists (`resetRuntime`), so requests start from a clean state like
      PHP-FPM. Add `max_execution_time` (terminate and replace the worker) and an approximate
      `memory_limit`.
- [ ] **Sessions**: `session_*`, the files handler, `SessionHandlerInterface` for custom
      handlers, and PHP-compatible cookie parameters.
- [ ] **Databases**: PDO core plus drivers. SQLite first, via the built-in synchronous
      `node:sqlite`. Then MySQL/MariaDB and PostgreSQL through the sync bridge. Add `mysqli`
      after PDO.
- [ ] **Integrations**: Express/Fastify/Connect middleware (`app.use(nip({ docroot }))`), a
      **FastCGI server** mode so nginx/Apache can use NIP in place of php-fpm, and adapters for
      serverless platforms (AWS Lambda, Vercel).
- [ ] Mail (`mail()` through a configurable transport) and `getenv`/`putenv` per request.

**Exit criteria:** an unmodified WordPress installs and serves pages with SQLite. The Laravel
and Symfony skeleton apps serve requests. Each runs its own test suite at an agreed pass rate.

## Phase 4: Performance

Benchmarks: `bench/` plus php-src's `Zend/bench.php` and `Zend/micro_bench.php`, tracked in CI
so regressions are visible.

- [ ] **Compiled variables**: resolve local variables to array slots at compile time when a
      function doesn't use `$$var`, `extract`, `compact`, `get_defined_vars`, `include` or
      `eval`. This removes the per-access name lookup and is the biggest win for call-heavy
      code.
- [ ] **Cheaper calls**: specialized calling paths for simple functions (no references,
      defaults or variadics), frame pooling, and avoiding `arguments` arrays.
- [ ] **Inline caches** at method call and property access sites (keyed by class), and fixed
      slot storage for declared properties instead of a `Map` per object.
- [ ] Fewer allocations: avoid boxing floats in arithmetic chains, use rope or builder strings
      for `.=` in loops, and add more packed-array fast paths.
- [ ] **Second-tier compiler**: generate JavaScript source (`new Function`) for hot functions
      instead of closure trees, so V8 can inline and optimize across PHP expressions.
- [ ] **Startup**: a V8 startup snapshot of the booted interpreter (`node --snapshot-blob`) and
      an on-disk cache of compiled scripts (the opcache equivalent for the CLI and server modes).
- [ ] Ship the single-file bundle as the npm entry point if it stays measurably faster than
      the ES module sources (currently about 5% on call-heavy code).

**Exit criteria:** no more than 1.5× slower than PHP 8.3 (without JIT) on `Zend/bench.php`, at
most 2× on `fib`, and startup under 30 ms.

## Phase 5: Production hardening

- [ ] **Sandboxing for embedders**: `disable_functions`, `open_basedir`, `allow_url_fopen`,
      blocking process execution, CPU-time and memory limits, and a pluggable virtual file
      system so a host application decides what PHP code can see.
- [ ] **Portable core**: put Node-specific code (fs, child_process, workers) behind interfaces
      so the interpreter also runs in browsers, Deno, Bun and edge runtimes (Cloudflare Workers).
- [ ] **Differential fuzzing**: generate random valid PHP programs, run them with `php` and NIP,
      and minimize any differences automatically.
- [ ] Debugging support: the Xdebug DBGp protocol (works with existing IDE debuggers) and source
      positions in internal errors.
- [ ] Observability for server mode: access/error logs, metrics, a slow-request log.
- [ ] A security review of the request-handling and sandbox code. Fuzz the HTTP/multipart
      parsers.
- [ ] Documentation site with a compatibility matrix generated from the php-src results.

**Exit criteria:** 1.0 release. Semver-stable embedding API, documented security model,
published compatibility matrix.

---

## Suggested order of work

Phases overlap. This order unlocks the most value earliest:

1. ~~Finish Phase 0 (baseline ratchet, unit tests, lint, first release).~~
2. ~~Reflection and attributes, since every framework is blocked on them.~~
3. The sync bridge, which unblocks networking and databases.
4. SAPI layer, `nip serve` and PDO SQLite: the first real web apps run.
5. Compiled variables and cheaper calls, the largest performance gap.
6. ~~The regex engine~~ and XML support, for library compatibility.
7. PHP 8.4/8.5 features, FastCGI, sandboxing, portable core.
