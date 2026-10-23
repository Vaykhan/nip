// NIP public API.
//
//   import { run, runFile } from 'nip';
//   const { output, exitCode } = run('<?php echo "hi";');      // output is captured by default
//   runFile('script.php', { argv: ['script.php'] });            // output goes to stdout
//
// Options: file (script name for run), argv (array of strings), capture (boolean), ini (object of ini settings).

import fs from 'node:fs';
import pathMod from 'node:path';
import './lib/index.js';
import { runScript } from './runtime/run.js';

export { cliMain } from './cli.js';

export function run(code, opts = {}) {
  const file = opts.file || 'nip-input';
  const r = runScript(code, file, opts.argv || [file], { capture: opts.capture !== false, ini: opts.ini });
  return { output: r.output, exitCode: r.exitCode };
}

export function runFile(path, opts = {}) {
  const src = fs.readFileSync(path, 'latin1');
  const r = runScript(src, pathMod.resolve(path), opts.argv || [path], { capture: !!opts.capture, ini: opts.ini });
  return { output: r.output, exitCode: r.exitCode };
}
