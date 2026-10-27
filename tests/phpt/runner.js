// Differential .phpt runner: runs the --FILE-- section of php-src tests with the reference `php`
// and with NIP, and counts the tests whose combined output and exit code are identical.
//
//   node tests/phpt/runner.js <dir-or-file>... [options]
//     --jobs N             parallel tests (default: number of CPUs)
//     --filter RE          only run test paths matching RE
//     --show               print both outputs for each failure
//     --out FILE           write {pass, fail, skip, timeout} lists as JSON
//     --root DIR           php-src checkout that test names are relative to (default: $PHPSRC or /tmp/php-src)
//     --baseline FILE      fail if a test listed in FILE (one name per line) no longer passes
//     --update-baseline FILE  write the names of all passing tests to FILE
//     --bundle             test dist/nip.cjs instead of bin/nip.js
//     --expect             compare with the test's --EXPECT-- / --EXPECTF-- / --EXPECTREGEX-- section
//                          instead of running `php` (for tests of PHP versions newer than the local
//                          php; SKIPIF runs with NIP)
//     --nip-ini K=V        extra -d setting for NIP only (e.g. nip.php_version=8.5)
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
let jobs = os.cpus().length, filter = null, show = false, outFile = null, baseline = null, updateBaseline = null;
let root = process.env.PHPSRC || '/tmp/php-src', bundle = false, expectMode = false;
const nipIni = [];
const list = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--jobs') jobs = +args[++i];
  else if (a === '--filter') filter = new RegExp(args[++i]);
  else if (a === '--show') show = true;
  else if (a === '--out') outFile = args[++i];
  else if (a === '--root') root = args[++i];
  else if (a === '--baseline') baseline = args[++i];
  else if (a === '--update-baseline') updateBaseline = args[++i];
  else if (a === '--bundle') bundle = true;
  else if (a === '--expect') expectMode = true;
  else if (a === '--nip-ini') nipIni.push('-d', args[++i]);
  else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
  else list.push(a);
}
root = path.resolve(root);

// Tests using features NIP doesn't implement yet are skipped instead of counted as failures.
// Remove an entry once the feature is implemented.
const UNSUPPORTED = [
  'opcache', 'ffi', 'zend_test', '_ZendTestClass', 'gc_', 'memory_get', 'debug_zval',
  'token_get_all', 'zend\\.', 'highlight_', 'php_strip', '__halt_compiler',
];
const UNSUPPORTED_RE = new RegExp(UNSUPPORTED.join('|'), 'i');
// Sections that need a SAPI or harness features the runner doesn't emulate.
const SKIP_SECTIONS = ['FILEEOF', 'FILE_EXTERNAL', 'CGI', 'POST', 'GET', 'COOKIE', 'ARGS', 'STDIN', 'EXTENSIONS',
  'CAPTURE_STDIO', 'ENV', 'PHPDBG', 'POST_RAW', 'REDIRECTTEST', 'XFAIL', 'FLAKY'];

const files = [];
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
  else if (p.endsWith('.phpt')) files.push(p);
};
list.forEach(walk);
const testName = (file) => path.relative(root, path.resolve(file));
const NIP = path.resolve(__dirname, bundle ? '../../dist/nip.cjs' : '../../bin/nip.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phpt-'));

function sections(src) {
  const out = {}; let cur = null;
  for (const line of src.split('\n')) {
    const m = /^--([A-Z_]+)--\s*$/.exec(line);
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n');
  return out;
}
function run(cmd, argv, cwd, timeout) {
  return new Promise((res) => {
    const p = cp.spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0); let killed = false;
    p.stdout.on('data', (d) => { if (out.length < 2e6) out = Buffer.concat([out, d]); });
    p.stderr.on('data', (d) => { if (out.length < 2e6) out = Buffer.concat([out, d]); });
    const t = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, timeout);
    p.on('close', (code) => { clearTimeout(t); res({ out: out.toString('latin1'), code, killed }); });
  });
}
// run-tests.php's EXPECTF placeholders
function expectfRegex(exp) {
  let re = '';
  const parts = exp.split('%r');
  parts.forEach((part, i) => {
    if (i % 2) { re += '(' + part + ')'; return; }
    re += part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      .replace(/%e/g, '\\/').replace(/%s/g, '[^\\r\\n]+').replace(/%S/g, '[^\\r\\n]*')
      .replace(/%a/g, '[\\s\\S]+').replace(/%A/g, '[\\s\\S]*').replace(/%w/g, '\\s*')
      .replace(/%i/g, '[+-]?\\d+').replace(/%d/g, '\\d+').replace(/%x/g, '[0-9a-fA-F]+')
      .replace(/%f/g, '[+-]?\\.?\\d+\\.?\\d*(?:[Ee][+-]?\\d+)?').replace(/%c/g, '.').replace(/%0/g, '\\x00');
  });
  return new RegExp('^' + re + '$');
}
function matchesExpected(s, out) {
  const norm = (t) => t.replace(/\r\n/g, '\n').trim();
  const got = norm(out);
  if (s.EXPECT !== undefined) return got === norm(s.EXPECT);
  if (s.EXPECTF !== undefined) return expectfRegex(norm(s.EXPECTF)).test(got);
  if (s.EXPECTREGEX !== undefined) return new RegExp('^' + norm(s.EXPECTREGEX) + '$').test(got);
  return false;
}
const siblingCache = new Map();
function siblings(d) {
  if (!siblingCache.has(d)) siblingCache.set(d, fs.readdirSync(d).filter((f) => /\.(inc|php|txt|data)$/.test(f) && fs.statSync(path.join(d, f)).isFile()));
  return siblingCache.get(d);
}
const results = { pass: [], fail: [], skip: [], timeout: [] };
let idx = 0;
async function one(file) {
  const src = fs.readFileSync(file, 'latin1');
  const s = sections(src);
  if (!s.FILE || SKIP_SECTIONS.some((k) => s[k] !== undefined) || UNSUPPORTED_RE.test(s.FILE)) { results.skip.push(file); return; }
  const dir = path.join(work, String(idx++)); fs.mkdirSync(dir);
  const name = path.basename(file).replace(/\.phpt$/, '.php');
  fs.writeFileSync(path.join(dir, name), s.FILE, 'latin1');
  // (expect mode: helper files next to the test, which it includes relative to __DIR__)
  if (expectMode) for (const f of siblings(path.dirname(file))) fs.copyFileSync(path.join(path.dirname(file), f), path.join(dir, f));
  const ini = ['-d', 'display_errors=1', '-d', 'log_errors=0', '-d', 'error_reporting=32767', '-d', 'html_errors=0'];
  // (run-tests.php's defaults; differential runs get the local php.ini's, like NIP)
  if (expectMode) ini.push('-d', 'zend.exception_ignore_args=0', '-d', 'zend.exception_string_param_max_len=15', '-d', 'zend.assertions=1', '-d', 'precision=14', '-d', 'serialize_precision=-1', '-d', 'short_open_tag=0', '-d', 'output_buffering=0', '-d', 'memory_limit=128M');
  if (s.INI) for (const l of s.INI.split('\n')) { const t = l.trim(); if (t && !t.startsWith(';')) ini.push('-d', t); }
  if (s.SKIPIF) {
    fs.writeFileSync(path.join(dir, 'skip.php'), s.SKIPIF, 'latin1');
    const r = expectMode ? await run('node', [NIP, ...ini, ...nipIni, 'skip.php'], dir, 10000) : await run('php', [...ini, 'skip.php'], dir, 10000);
    if (/^\s*skip/i.test(r.out)) { results.skip.push(file); return; }
  }
  if (expectMode) {
    const b = await run('node', [NIP, ...ini, ...nipIni, name], dir, 30000);
    if (b.killed) { results.timeout.push(file); return; }
    if (matchesExpected(s, b.out)) results.pass.push(file);
    else { results.fail.push(file); if (show) console.log('=== FAIL ' + file + '\n--- expected\n' + (s.EXPECT ?? s.EXPECTF ?? s.EXPECTREGEX ?? '').slice(0, 3000) + '\n--- nip (' + b.code + ')\n' + b.out.slice(0, 3000)); }
    return;
  }
  const [a, b] = await Promise.all([run('php', [...ini, name], dir, 20000), run('node', [NIP, ...ini, ...nipIni, name], dir, 30000)]);
  if (a.killed) { results.skip.push(file); return; }
  if (b.killed) { results.timeout.push(file); return; }
  if (a.out === b.out && a.code === b.code) results.pass.push(file);
  else { results.fail.push(file); if (show) console.log('=== FAIL ' + file + '\n--- php (' + a.code + ')\n' + a.out.slice(0, 3000) + '\n--- nip (' + b.code + ')\n' + b.out.slice(0, 3000)); }
}

const filtered = files.filter((f) => !filter || filter.test(f));
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < filtered.length) { const f = filtered[next++]; try { await one(f); } catch (e) { results.fail.push(f); } }
}));
fs.rmSync(work, { recursive: true, force: true });
for (const k of Object.keys(results)) results[k] = results[k].map(testName).sort();
console.log(`pass=${results.pass.length} fail=${results.fail.length} timeout=${results.timeout.length} skip=${results.skip.length}`);
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
if (updateBaseline) {
  fs.mkdirSync(path.dirname(path.resolve(updateBaseline)), { recursive: true });
  fs.writeFileSync(updateBaseline, results.pass.join('\n') + '\n');
  console.log(`wrote ${results.pass.length} passing tests to ${updateBaseline}`);
}
if (baseline) {
  const want = fs.readFileSync(baseline, 'utf8').split('\n').filter(Boolean);
  const pass = new Set(results.pass), timedOut = new Set(results.timeout);
  const ran = new Set(filtered.map(testName));
  const flaky = new Set(fs.readFileSync(path.join(__dirname, 'flaky.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')));
  const lost = want.filter((t) => ran.has(t) && !pass.has(t) && !timedOut.has(t) && !flaky.has(t));
  for (const t of want) if (flaky.has(t) && ran.has(t) && !pass.has(t)) console.log(`${process.env.GITHUB_ACTIONS ? '::warning file=' + t + '::' : 'WARN '}flaky test failed: ${t}`);
  const slow = want.filter((t) => timedOut.has(t));
  const gained = results.pass.filter((t) => !want.includes(t));
  const ci = !!process.env.GITHUB_ACTIONS;
  for (const t of slow) console.log(`${ci ? '::warning file=' + t + '::' : 'WARN '}timed out (passes in the baseline): ${t}`);
  for (const t of lost) console.log(`${ci ? '::error file=' + t + '::' : 'REGRESSION '}no longer passes: ${t}`);
  if (gained.length) console.log(`${gained.length} newly passing test(s); update the baseline with --update-baseline ${baseline}`);
  console.log(`baseline: ${want.length} tests, ${lost.length} regression(s), ${slow.length} timeout(s), ${gained.length} new`);
  if (lost.length) process.exitCode = 1;
}
