#!/usr/bin/env node
// Test runner for tests/cases/*.php.
//
// Each case is run with NIP and its combined stdout+stderr and exit code are compared with the
// expected output in tests/cases/<name>.out, which was produced by the reference PHP 8.3 binary.
//
//   node tests/run.js [options] [name...]
//     --bundle   test dist/nip.cjs (run `npm run build` first) instead of bin/nip.js
//     --php      compare with the output of `php` (on PATH) instead of the .out files
//     --update   regenerate the .out files with `php`
//     --verbose  print a diff for each failure

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CASES = path.join(ROOT, 'tests', 'cases');

const opts = { bundle: false, php: false, update: false, verbose: false };
const names = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--') && a.slice(2) in opts) opts[a.slice(2)] = true;
  else if (a.startsWith('-')) { console.error(`unknown option ${a}`); process.exit(2); }
  else names.push(path.basename(a, '.php'));
}
const cases = names.length ? names : fs.readdirSync(CASES).filter((f) => f.endsWith('.php')).map((f) => f.slice(0, -4)).sort();
const nip = opts.bundle ? path.join(ROOT, 'dist', 'nip.cjs') : path.join(ROOT, 'bin', 'nip.js');
if (opts.bundle && !fs.existsSync(nip)) { console.error('dist/nip.cjs not found: run `npm run build` first'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nip-test-'));
const realCases = fs.realpathSync(CASES);

// Runs cmd with stdout and stderr going to the same file, so their interleaving is preserved.
function exec(cmd, args, tag) {
  return new Promise((resolve) => {
    const outFile = path.join(tmp, `${tag}.txt`);
    const fd = fs.openSync(outFile, 'w');
    const child = spawn(cmd, args, { cwd: CASES, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      const out = fs.readFileSync(outFile, 'latin1').split(realCases).join('{dir}').split(CASES).join('{dir}');
      resolve(`${out}${out.endsWith('\n') || out === '' ? '' : '\n'}[exit ${signal ? signal : code}]\n`);
    });
  });
}

function firstDiff(want, got) {
  const a = want.split('\n'), b = got.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `  line ${i + 1}\n    expected: ${JSON.stringify(a[i])}\n    actual:   ${JSON.stringify(b[i])}`;
  }
  return '';
}

async function runCase(name) {
  const file = `${name}.php`, expFile = path.join(CASES, `${name}.out`);
  if (opts.update) {
    fs.writeFileSync(expFile, await exec('php', [file], `${name}-php`), 'latin1');
    return { name, ok: true };
  }
  const [want, got] = await Promise.all([
    opts.php ? exec('php', [file], `${name}-php`) : fs.promises.readFile(expFile, 'latin1').catch(() => null),
    exec(process.execPath, [nip, file], `${name}-nip`),
  ]);
  if (want === null) return { name, ok: false, why: `missing ${path.relative(ROOT, expFile)} (generate it with --update)` };
  return { name, ok: want === got, why: firstDiff(want, got) };
}

const results = [];
const queue = [...cases];
await Promise.all(Array.from({ length: Math.min(os.cpus().length, 8) }, async () => {
  while (queue.length) results.push(await runCase(queue.shift()));
}));
fs.rmSync(tmp, { recursive: true, force: true });

if (opts.update) { console.log(`updated ${results.length} expected outputs`); process.exit(0); }
const failed = results.filter((r) => !r.ok).sort((a, b) => a.name.localeCompare(b.name));
for (const f of failed) console.log(`FAIL ${f.name}${opts.verbose || f.why.startsWith('missing') ? '\n' + f.why : ''}`);
console.log(`${results.length - failed.length}/${results.length} passed${opts.bundle ? ' (dist/nip.cjs)' : ''}${opts.php ? ' (vs php)' : ''}`);
process.exit(failed.length ? 1 : 0);
