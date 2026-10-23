// Unit tests for the embedding API (src/index.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, runFile } from '../../src/index.js';

test('run() captures output and the exit code', () => {
  assert.deepEqual(run('<?php echo "a", 1 + 1;'), { output: 'a2', exitCode: 0 });
  assert.deepEqual(run('<?php echo "x"; exit(3);'), { output: 'x', exitCode: 3 });
});

test('run() isolates runs from each other', () => {
  run('<?php function only_in_first_run() {} $GLOBALS["g"] = 1; define("C1", 1);');
  assert.equal(run('<?php var_dump(function_exists("only_in_first_run"), isset($g), defined("C1"));').output,
    'bool(false)\nbool(false)\nbool(false)\n');
});

test('run() applies ini settings', () => {
  assert.equal(run('<?php echo 1/3;', { ini: { precision: '5' } }).output, '0.33333');
  assert.equal(run('<?php echo ini_get("precision");').output, '14');
});

test('run() reports uncaught exceptions like PHP', () => {
  const r = run('<?php throw new RuntimeException("boom");', { file: 'x.php' });
  assert.equal(r.exitCode, 255);
});

test('run() passes argv', () => {
  assert.equal(run('<?php echo $argc, " ", implode(",", $argv);', { argv: ['s.php', 'a', 'b'] }).output, '3 s.php,a,b');
});

test('runFile() runs a script from disk with capture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nip-unit-'));
  try {
    fs.writeFileSync(path.join(dir, 'inc.php'), '<?php return 40;');
    fs.writeFileSync(path.join(dir, 'main.php'), '<?php echo (require __DIR__ . "/inc.php") + 2;');
    assert.deepEqual(runFile(path.join(dir, 'main.php'), { capture: true }), { output: '42', exitCode: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runFile() recompiles an included file that changed since the last run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nip-unit-'));
  try {
    const lib = path.join(dir, 'lib.php'), main = path.join(dir, 'main.php');
    fs.writeFileSync(lib, '<?php function v() { return 1; }');
    fs.writeFileSync(main, '<?php require __DIR__ . "/lib.php"; echo v();');
    assert.equal(runFile(main, { capture: true }).output, '1');
    fs.writeFileSync(lib, '<?php function v() { return 22; }');
    assert.equal(runFile(main, { capture: true }).output, '22');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disable_functions removes builtins for that run only', () => {
  const code = '<?php var_dump(function_exists("strlen"), function_exists("date_create")); try { strlen("x"); } catch (Error $e) { echo $e->getMessage(), "\n"; }';
  assert.equal(run(code, { ini: { disable_functions: 'strlen,date_create' } }).output,
    'bool(false)\nbool(false)\nCall to undefined function strlen()\n');
  assert.equal(run('<?php echo strlen("abc");').output, '3');
});

