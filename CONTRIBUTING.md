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
| `npm test` | Runs `tests/cases/*.php` and compares with the expected `.out` files. |
| `npm run test:bundle` | Builds `dist/nip.cjs` and runs the same tests against it. |
| `npm run test:php` | Compares directly with your local `php` instead of the `.out` files. |
| `node tests/run.js --verbose NAME` | Runs one case and shows the first differing line. |
| `node tests/phpt/runner.js DIR --out res.json` | Runs php-src `.phpt` tests in `DIR` with both PHP and NIP. |
| `node tests/phpt/cluster.js res.json` | Groups the failures from a run by their first differing line. |
| `tests/phpt/one.sh NAME.phpt` | Shows one `.phpt` test's code and both outputs. |

To get php-src's tests:

```sh
git clone --depth 1 --branch php-8.3.6 --filter=blob:none --sparse https://github.com/php/php-src /tmp/php-src
git -C /tmp/php-src sparse-checkout set tests Zend/tests ext/standard/tests ext/json/tests ext/pcre/tests
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
- Run `npm test` and `npm run test:bundle` before you push. For changes to the language core,
  also run `tests/phpt/runner.js` on `tests/lang` and `Zend/tests` and compare the pass counts
  with `main`.
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
