#!/usr/bin/env node
// Mutation fuzzer: takes PHP test scripts, mutates them at the token level, and runs the result.
// Any outcome a PHP script can have is fine (output, warnings, exceptions, parse errors, fatal
// errors, infinite loops). An internal JavaScript exception escaping the interpreter is a bug:
// each one is reported once and saved as a reproducer in fuzz-out/.
//
//   node scripts/fuzz.js [--iterations N] [--seed S] [--timeout MS] [--jobs N] [corpus files or dirs...]
//   node scripts/fuzz.js --minimize fuzz-out/crash-1.php     shrink a reproducer, keeping the same error
//
// The default corpus is tests/cases/*.php. Mutated scripts run with file, process and network
// functions disabled, in a scratch directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// functions that could touch the host if a mutation strings together the wrong tokens
const DISABLED = [
  'exec', 'system', 'passthru', 'shell_exec', 'proc_open', 'popen', 'pcntl_exec', 'mail',
  'unlink', 'rmdir', 'rename', 'copy', 'mkdir', 'touch', 'chmod', 'chown', 'symlink', 'link', 'tempnam', 'tmpfile',
  'file_put_contents', 'fopen', 'fwrite', 'fputs', 'ftruncate', 'move_uploaded_file', 'file_get_contents', 'readfile',
  'file', 'fsockopen', 'stream_socket_client', 'stream_socket_server', 'curl_exec', 'set_time_limit', 'sleep',
  'usleep', 'time_nanosleep', 'time_sleep_until', 'putenv', 'dl', 'ini_set', 'include', 'require',
];

async function main() {
  const mi = process.argv.indexOf('--minimize');
  if (mi >= 0) return minimize(process.argv[mi + 1]);
  const opts = { iterations: 2000, seed: Date.now() % 1e9, timeout: 2000, jobs: Math.max(1, Math.min(os.cpus().length, 8)) };
  const inputs = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.slice(2) in opts) opts[a.slice(2)] = +argv[++i];
    else if (a.startsWith('-')) { console.error(`unknown option ${a}`); process.exit(2); }
    else inputs.push(a);
  }
  const corpus = loadCorpus(inputs.length ? inputs : [path.join(ROOT, 'tests', 'cases')]);
  if (!corpus.length) { console.error('empty corpus'); process.exit(2); }
  const rand = mulberry32(opts.seed);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nip-fuzz-'));
  const outDir = path.join(ROOT, 'fuzz-out');
  process.chdir(scratch); // workers inherit it (they can't chdir themselves)
  console.log(`seed ${opts.seed}, ${corpus.length} corpus files, ${opts.iterations} iterations, ${opts.jobs} workers`);

  const seen = new Map(); // signature -> count
  let done = 0, timeouts = 0, crashes = 0, nextId = 0;
  const startWorker = () => new Worker(new URL(import.meta.url), {
    stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 64 },
  });
  const runOne = (state, code) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { state.worker.terminate(); state.worker = startWorker(); timeouts++; resolve(); }, opts.timeout);
    const onMsg = (m) => {
      if (m.id !== id) return;
      clearTimeout(timer); state.worker.off('message', onMsg); state.worker.off('error', onErr);
      if (m.internal) report(code, m.internal);
      resolve();
    };
    const onErr = (e) => { // e.g. out of memory
      clearTimeout(timer); state.worker.off('message', onMsg);
      if (!crashes++) console.log(`worker crashed: ${(e && e.message) || e}`);
      state.worker = startWorker(); resolve();
    };
    state.worker.on('message', onMsg); state.worker.once('error', onErr);
    state.worker.postMessage({ id, code });
  });
  function report(code, stack) {
    const lines = stack.split('\n');
    const frame = (lines.find((l) => /^\s+at /.test(l)) || '').trim().replace(/:\d+:\d+\)?$/, '');
    const sig = `${lines[0]} @ ${frame}`;
    seen.set(sig, (seen.get(sig) || 0) + 1);
    if (seen.get(sig) > 1) return;
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `crash-${seen.size}.php`);
    fs.writeFileSync(file, code, 'latin1');
    console.log(`\nINTERNAL ERROR #${seen.size}: ${lines[0]}\n  ${lines.slice(1, 4).map((l) => l.trim()).join('\n  ')}\n  reproducer: ${path.relative(process.cwd(), file)}`);
  }

  const pool = Array.from({ length: opts.jobs }, () => ({ worker: startWorker() }));
  let issued = 0;
  await Promise.all(pool.map(async (state) => {
    while (issued < opts.iterations) {
      issued++;
      await runOne(state, mutate(corpus[Math.floor(rand() * corpus.length)], corpus, rand));
      if (++done % 500 === 0) process.stdout.write(`  ${done}/${opts.iterations}\n`);
    }
    await state.worker.terminate();
  }));
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${done} runs, ${seen.size} distinct internal error(s), ${timeouts} timeout(s), ${crashes} worker crash(es)`);
  process.exitCode = seen.size ? 1 : 0;
}

function loadCorpus(inputs) {
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    else if (p.endsWith('.php')) files.push(p);
    else if (p.endsWith('.phpt')) files.push(p);
  };
  inputs.forEach(walk);
  return files.map((f) => {
    let src = fs.readFileSync(f, 'latin1');
    if (f.endsWith('.phpt')) { const m = /^--FILE--\r?\n([\s\S]*?)^--[A-Z_]+--/m.exec(src); src = m ? m[1] : ''; }
    return tokenize(src);
  }).filter((t) => t.length > 2);
}

// Rough PHP tokenizer: good enough to cut source into mutation units without splitting strings.
function tokenize(src) {
  const re = /<\?php|\?>|\$[A-Za-z_]\w*|[A-Za-z_\\][\w\\]*|0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s+|<<=|>>=|\*\*=|\.\.\.|<=>|===|!==|\?\?=|\?->|::|->|=>|\+\+|--|&&|\|\||\?\?|[-+*/%.<>=!&|^~?:;,()[\]{}@#`]=?|[\s\S]/g;
  return src.match(re) || [];
}

const EXTRA = ['(', ')', '{', '}', '[', ']', ';', ',', '$x', '$this', '$$x', 'null', '0', '-1', "''", '"$x"', 'PHP_INT_MAX',
  'new', 'clone', 'yield', 'yield from', 'fn', 'function', 'static', 'return', 'throw', 'match', 'list', 'array', 'isset',
  'unset', 'goto', 'break', 'continue 2', 'class', 'enum', 'trait', 'interface', 'extends', '...', '&', '=', '?->', '::',
  '->', '++', '**', '<=>', '??=', '.=', 'instanceof', '(int)', '(string)', '(array)', '(object)', '@', 'echo', 'print',
  'try', 'catch', 'finally', 'declare(strict_types=1);', '#[A]', 'readonly', 'abstract', 'parent::', 'self::', 'static::'];

function mutate(tokens, corpus, rand) {
  const t = tokens.slice();
  const pick = () => Math.floor(rand() * t.length);
  const n = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < n; k++) {
    const i = pick(), len = 1 + Math.floor(rand() * 6);
    switch (Math.floor(rand() * 6)) {
      case 0: t.splice(i, len); break; // delete a span
      case 1: t.splice(i, 0, ...t.slice(pick(), pick() + len)); break; // duplicate a span elsewhere
      case 2: { const j = pick(); [t[i], t[j]] = [t[j], t[i]]; break; } // swap two tokens
      case 3: t.splice(i, 0, ' ', EXTRA[Math.floor(rand() * EXTRA.length)], ' '); break; // insert a keyword/operator
      case 4: { const o = corpus[Math.floor(rand() * corpus.length)]; const s = Math.floor(rand() * o.length); t.splice(i, 0, ...o.slice(s, s + len * 3)); break; } // splice from another file
      case 5: t.length = Math.max(2, i); break; // truncate
    }
  }
  const code = t.join('');
  return code.startsWith('<?php') ? code : '<?php ' + code;
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

if (!isMainThread) {
  // worker: run scripts on request
  const { run } = await import('../src/index.js');
  parentPort.on('message', ({ id, code }) => {
    let internal = null;
    try { run(code, { file: 'fuzz.php', ini: { disable_functions: DISABLED.join(',') } }); }
    catch (e) { if (!(e instanceof RangeError)) internal = String((e && e.stack) || e); }
    parentPort.postMessage({ id, internal });
  });
} else {
  await main();
}

// Delta debugging over tokens: repeatedly drop chunks while the script still fails with the same
// first line of the internal error. Runs the CLI in a child process so hangs can be timed out.
async function minimize(file) {
  const { spawnSync } = await import('node:child_process');
  const nip = path.join(ROOT, 'bin', 'nip.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nip-min-'));
  const errorOf = (code) => {
    fs.writeFileSync(path.join(tmp, 'm.php'), code, 'latin1');
    const r = spawnSync(process.execPath, [nip, '-d', `disable_functions=${DISABLED.join(',')}`, 'm.php'], { cwd: tmp, encoding: 'latin1', timeout: 5000 });
    const m = /Internal interpreter error: ([^\n]*)/.exec((r.stderr || '') + (r.stdout || ''));
    return m ? m[1] : null;
  };
  let toks = tokenize(fs.readFileSync(file, 'latin1'));
  const want = errorOf(toks.join(''));
  if (!want) { console.log('the file does not trigger an internal error'); return; }
  console.log(`target: ${want}`);
  for (let chunk = Math.max(1, toks.length >> 1); chunk >= 1; chunk >>= 1) {
    for (let i = 0; i < toks.length;) {
      const cand = toks.slice(0, i).concat(toks.slice(i + chunk));
      if (cand.length && errorOf(cand.join('')) === want) toks = cand; else i += chunk;
    }
  }
  const out = file.replace(/\.php$/, '') + '.min.php';
  fs.writeFileSync(out, toks.join(''), 'latin1');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${toks.join('').length} bytes -> ${out}\n${toks.join('')}`);
}

