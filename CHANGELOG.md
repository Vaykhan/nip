# Changelog

All notable changes to NIP are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0, minor versions may contain breaking
changes to the embedding API.

## [Unreleased]

### Added
- `disable_functions` ini setting.
- Compile-time checks PHP performs on a whole file before running it, starting with misuse
  of `[]` ("Cannot use [] for reading/unsetting", "Cannot append to $GLOBALS") and invalid
  destructuring ("Cannot use empty list", mixing keyed and unkeyed entries, spread in
  assignments).
- Development: unit tests (`node:test`), ESLint, a mutation fuzzer with a reproducer
  minimizer (`scripts/fuzz.js`), php-src baselines that CI enforces
  (`tests/phpt/baseline/`), and a release workflow.

### Fixed
- Internal errors found by fuzzing: by-reference destructuring of objects and strings,
  string offsets beyond 2^53, output-buffer callbacks throwing during shutdown.
- Included files and `eval()` code reused across `run()` calls kept the previous run's
  functions (and their static variables) at call sites.
- Included files that changed between `run()` calls were not recompiled.
- Boolean string offsets now warn "String offset cast occurred", as in PHP.

### Changed
- The npm package is named `@vaykhan/nip` (the `nip` name is taken). The command is still `nip`.

## [0.1.0] - 2026-10-23

First version: PHP 8.3 interpreter with the language core, about 600 builtin functions, SPL
and DateTime, a php-compatible CLI and an embedding API.

[Unreleased]: https://github.com/Vaykhan/nip/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Vaykhan/nip/releases/tag/v0.1.0
