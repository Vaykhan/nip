// Command-line interface (php-compatible options).

import fs from 'node:fs';
import pathMod from 'node:path';
import { ParseErr } from './values.js';
import { parsePHP } from './parser.js';
import { PHP_VERSION } from './runtime/native-classes.js';
import { boot } from './runtime/boot.js';
import { runScript } from './runtime/run.js';
import { rt } from './runtime/state.js';
import { writeErr } from './runtime/errors.js';

export function cliMain(argv) {
  let code = null, file = null, lint = false;
  const ini = {};
  const rest = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (file !== null || code !== null) { rest.push(a); continue; }
    if (a === '-r') { code = '<?php ' + argv[++i]; file = 'Command line code'; continue; }
    if (a === '-l') { lint = true; continue; }
    if (a === '-f') { file = argv[++i]; continue; }
    if (a === '-d') { const kv = argv[++i] || ''; const eq = kv.indexOf('='); ini[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '1' : kv.slice(eq + 1); continue; }
    if (a.startsWith('-d') && a.length > 2) { const kv = a.slice(2); const eq = kv.indexOf('='); ini[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '1' : kv.slice(eq + 1); continue; }
    if (a === '-v' || a === '--version') { process.stdout.write(`PHP ${PHP_VERSION} (cli) (NIP on Node.js ${process.version})\n`); return 0; }
    if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: nip [options] [-f] <file> [--] [args...]\n       nip [options] -r <code> [--] [args...]\n\n  -d foo[=bar]     Define INI entry foo with value \'bar\'\n  -f <file>        Parse and execute <file>.\n  -l               Syntax check only (lint)\n  -r <code>        Run PHP <code> without using script tags <?..?>\n  -v               Version number\n  -h               This help\n');
      return 0;
    }
    if (a === '--') continue;
    file = a;
  }
  let src;
  if (code !== null) src = code;
  else if (file === null || file === '-') {
    try { src = fs.readFileSync(0, 'latin1'); } catch (e) { src = ''; }
    file = 'Standard input code';
  } else {
    try { src = fs.readFileSync(file, 'latin1'); }
    catch (e) { process.stderr.write(`Could not open input file: ${file}\n`); return 1; }
    file = pathMod.resolve(file);
  }
  const scriptArgs = [code !== null ? 'Standard input code' : (file === 'Standard input code' ? '-' : argv[argv.indexOf(rest[0]) - 1] === undefined ? file : file), ...rest];
  if (code === null && file !== 'Standard input code') scriptArgs[0] = argv.find((x) => pathMod.resolve(x) === file) || file;
  if (code !== null) scriptArgs[0] = 'Standard input code';
  if (lint) {
    try { boot(); parsePHP(src, file); process.stdout.write(`No syntax errors detected in ${file}\n`); return 0; }
    catch (e) { if (e instanceof ParseErr) { process.stdout.write(`PHP Parse error:  ${e.msg} in ${file} on line ${e.line}\nErrors parsing ${file}\n`); return 255; } throw e; }
  }
  const r = runScript(src, file, scriptArgs, { ini });
  return r.exitCode;
}

// Runs the CLI and converts interpreter-level failures into PHP-style fatal errors. Returns the exit code.
export function main(argv) {
  try { return cliMain(argv); }
  catch (e) {
    rt.flush();
    if (e instanceof RangeError) { writeErr('Fatal error', 'Maximum call stack size reached. Infinite recursion?'); return 255; }
    process.stderr.write('PHP Fatal error:  Internal interpreter error: ' + ((e && e.stack) || e) + '\n');
    return 255;
  }
}
