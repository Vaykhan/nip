# Contributing to NIP

NIP aims to behave exactly like PHP 8.3: same output, same warnings, same exit codes. The
reference PHP binary is the specification, and every change is checked against it.

## Setup

Node.js 22 or newer. There are no dependencies to install.

```sh
git clone https://github.com/Vaykhan/nip && cd nip
node bin/nip.js -r 'echo "hello\n";'
npm test
```

For writing new tests and running php-src's test suite you also need PHP 8.3 on `PATH`
(`apt install php8.3-cli` on Ubuntu 24.04).

## Tests

| Command | What it does |
|---|---|
| `npm test` | Unit tests (`tests/unit`), then `tests/cases/*.php` compared with the expected `.out` files. |
| `npm run lint` | ESLint (run `npm install` once first). |
| `npm run test:bundle` | Builds `dist/nip.cjs` and runs the PHP cases against it. |
| `npm run test:php` | Compares the cases directly with your local `php` instead of the `.out` files. |
| `node tests/run.js --verbose NAME` | Runs one case and shows the first differing line. |
| `node tests/phpt/runner.js DIR --baseline FILE` | Runs php-src `.phpt` tests in `DIR` with both PHP and NIP and fails if a test listed in the baseline no longer passes. |
| `node tests/phpt/runner.js DIR --update-baseline FILE` | Records the currently passing tests as the new baseline. |
| `node tests/phpt/cluster.js res.json` | Groups the failures from a `--out res.json` run by their first differing line. |
| `tests/phpt/one.sh NAME.phpt` | Shows one `.phpt` test's code and both outputs. |
| `node scripts/fuzz.js [--iterations N] [corpus...]` | Mutation fuzzer: reports internal JS errors with reproducers in `fuzz-out/`. |
| `node scripts/fuzz.js --minimize FILE` | Shrinks a reproducer to the smallest script with the same error. |

To get php-src's tests:

```sh
git clone --depth 1 --branch php-8.3.6 --filter=blob:none --sparse https://github.com/php/php-src /tmp/php-src
git -C /tmp/php-src sparse-checkout set tests Zend/tests ext/standard/tests ext/json/tests ext/pcre/tests \
  ext/spl/tests ext/date/tests ext/reflection/tests
```

### php-src baselines

`tests/phpt/baseline/<suite>.txt` lists the php-src tests NIP currently passes, one file per
suite (`Zend/tests` → `Zend_tests.txt`). CI runs every suite on each pull request and fails if a
listed test stops passing. When a change makes more tests pass, record them so they stay passing:

```sh
node tests/phpt/runner.js /tmp/php-src/Zend/tests --root /tmp/php-src --update-baseline tests/phpt/baseline/Zend_tests.txt
```

### Adding a test case

1. Write `tests/cases/NN_topic.php`. Keep the output deterministic: no current time, random
   numbers without a seed, or absolute paths outside the tests directory.
2. Generate the expected output with real PHP: `node tests/run.js --update NN_topic`.
3. Check that it passes: `node tests/run.js NN_topic`.

## Making changes

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. It covers the value model, how the
  compiler works, and the two module rules the single-file build depends on.
- Copy PHP's messages exactly, including the punctuation and the `Argument #1 ($name)` form.
  Check them against `php`, not from memory.
- Every bug fix should come with a test case, or with an improved count from a php-src suite.
- Run `npm run lint`, `npm test` and `npm run test:bundle` before you push. For changes to the
  language core, also check the `tests` and `Zend/tests` baselines locally; CI checks all of them.
- Keep runtime code dependency-free. Development tools may have dependencies.

### Adding a builtin function

Add it to the matching `src/lib/*.js` module with `def()`, using the PHP parameter names as the
JS parameter names and the argument helpers (`S`, `I`, `N`, `B`, `A`) to coerce arguments. See
"Builtin functions" in the architecture document. A new module also has to be added to
`src/lib/index.js` and to `MODULES` in `scripts/build.js`.

## Code style

Two-space indentation, single quotes, semicolons. Follow the style of the surrounding code.
Comments explain PHP behaviour that isn't obvious ("PHP evaluates the dimension before the
right-hand side here"), not what the JavaScript does.

## Releasing

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new `## [X.Y.Z] - date` heading
   and update the links at the bottom.
2. Set `"version"` in `package.json` to `X.Y.Z`.
3. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The release workflow runs the tests, attaches `dist/nip.cjs` to a GitHub release with the
changelog notes, and publishes `@vaykhan/nip` to npm if the repository has an `NPM_TOKEN` secret.
