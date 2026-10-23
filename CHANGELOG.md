# Changelog

All notable changes to NIP are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking
changes to the embedding API.

## [Unreleased]

### Added
- Reflection: `ReflectionClass`, `ReflectionObject`, `ReflectionMethod`, `ReflectionFunction`,
  `ReflectionProperty`, `ReflectionParameter`, `ReflectionClassConstant`, `ReflectionEnum`
  (and its case classes), `ReflectionNamedType`/`ReflectionUnionType`/`ReflectionIntersectionType`,
  `ReflectionAttribute`, `ReflectionExtension` and doc comments.
- Attributes: parsed everywhere PHP allows them, validated (targets, repetition) and exposed
  through Reflection. Engine attributes `#[\Attribute]`, `#[\Override]`,
  `#[\AllowDynamicProperties]`, `#[\SensitiveParameter]` and `#[\ReturnTypeWillChange]`.
- Fibers (`Fiber`, `FiberError`): suspension from nested function and method calls,
  `throw()`, `getReturn()`, and `finally` blocks of unfinished fibers running on destruction.
- `goto`, including jumps into `if`/`else`/`try` blocks and inside `switch`.
- `declare(ticks=N)`, `register_tick_function()`, `unregister_tick_function()`.
- The PHP 8.2 "Creation of dynamic property" deprecation.
- `disable_functions` ini setting.
- Compile-time checks PHP performs on a whole file before running it: misuse of `[]`
  ("Cannot use [] for reading/unsetting", "Cannot append to $GLOBALS"), invalid
  destructuring, `goto` rules, duplicate and conflicting modifiers, interface and enum rules,
  `readonly` and promoted property rules, invalid type declarations, `self`/`parent`/`static`
  outside a class, `void`/`never` returns, writes to `$this`, constant expression rules,
  writes to temporary values, and more.
- Inheritance checks done when a class is linked: method signature compatibility
  (contravariant parameters, covariant return types, "Declaration of ... must be compatible
  with ..."), deprecations for tentative return types of internal methods, static/abstract/
  visibility changes, and property and class constant redeclaration rules.
- Classes are declared at compile time only when PHP would (no interfaces or traits, parent
  already declared); other classes exist from the moment their declaration runs.
- Reflection reports PHP's real parameter names, types, defaults and (tentative) return types
  for methods of internal classes (`src/runtime/arginfo.js`, generated from PHP).
- `ArrayObject::ARRAY_AS_PROPS` and `ArrayIterator::ARRAY_AS_PROPS`.
- `-d` values are read like PHP's INI parser does: `E_ALL & ~E_NOTICE` and other constant
  expressions, `On`/`Off`/`Yes`/`No`/`None`, quotes and `${ENV}` variables.
- PHP's lexer errors for unbalanced brackets ("Unclosed '{' on line 3", "Unmatched ')'", ...)
  and for invalid array offsets in strings (`"$a['x']"`).
- More compile-time errors: invalid default values for typed parameters and properties,
  duplicate static variables.
- A PCRE2-compatible regex engine for `preg_*` (replacing the translation to JS `RegExp`):
  recursion, subroutine calls, conditionals, `\K`, backtracking verbs, atomic groups and
  possessive quantifiers, branch reset, duplicate names, Unicode properties and case folding,
  PCRE2's compile error messages and offsets, and PHP's handling of empty matches, invalid
  UTF-8 and the backtrack/recursion/JIT stack limits.
- Development: unit tests (`node:test`), ESLint, a mutation fuzzer with a reproducer
  minimizer (`scripts/fuzz.js`), php-src baselines that CI enforces
  (`tests/phpt/baseline/`), and a release workflow.

### Fixed
- `foreach` by reference follows the array like PHP's hash iterators: through `array_shift()`,
  `array_unshift()` and compaction, and when the variable is given another array. `foreach`
  over an object visits properties added during the loop.
- `assert()` doesn't evaluate its argument unless `zend.assertions=1`; called dynamically, it
  checks `assert.active` only.
- The exit status is 0 when a user exception handler handled an uncaught exception.
- `f($b =& $a)` passes the new reference to a by-reference parameter.
- `zend_version()` reports 4.3.6.
- A `?>` followed by a lone `\r` now swallows it, like PHP.
- `Closure`, `Generator`, `WeakReference` and `Fiber` objects refuse dynamic properties.
- Internal errors found by fuzzing: by-reference destructuring of objects and strings,
  string offsets beyond 2^53, output-buffer callbacks throwing during shutdown.
- Included files and `eval()` code reused across `run()` calls kept the previous run's
  functions (and their static variables) at call sites.
- Included files that changed between `run()` calls were not recompiled.
- Errors raised inside functions implemented in the PHP prelude now report the caller's file
  and line, and prelude frames no longer appear in stack traces.
- Boolean string offsets now warn "String offset cast occurred", as in PHP.

### Changed
- The npm package is named `@vaykhan/nip` (the `nip` name is taken). The command is still `nip`.

## [0.1.0] - 2026-10-23

First version: PHP 8.3 interpreter with the language core, about 600 builtin functions, SPL
and DateTime, a php-compatible CLI and an embedding API.

[Unreleased]: https://github.com/Vaykhan/nip/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Vaykhan/nip/releases/tag/v0.1.0
