// Differential .phpt runner: runs the --FILE-- section with the reference `php` and with NIP,
// compares combined output. Usage: node runner.js <dir-or-file>... [--jobs N] [--filter re] [--show]
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
let jobs = os.cpus().length, filter = null, show = false, list = [], outFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--jobs') jobs = +args[++i];
  else if (args[i] === '--filter') filter = new RegExp(args[++i]);
  else if (args[i] === '--show') show = true;
  else if (args[i] === '--out') outFile = args[++i];
  else list.push(args[i]);
}
const files = [];
const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f)); else if (p.endsWith('.phpt')) files.push(p); };
list.forEach(walk);
const NIP = path.resolve(__dirname, '../../bin/nip.js');
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
const results = { pass: [], fail: [], skip: [], timeout: [], phpfail: [] };
let idx = 0;
async function one(file) {
  const src = fs.readFileSync(file, 'latin1');
  const s = sections(src);
  if (!s.FILE || s.FILEEOF !== undefined || s.FILE_EXTERNAL || s.CGI !== undefined || s.POST || s.GET || s.COOKIE || s.ARGS || s.STDIN || s.EXTENSIONS || s.CAPTURE_STDIO || s.ENV || s.PHPDBG || s.POST_RAW || s.REDIRECTTEST || s.XFAIL !== undefined || s.FLAKY !== undefined) { results.skip.push(file); return; }
  if (/opcache|ffi|zend_test|_ZendTestClass|gc_|memory_get|Fiber|WeakReference|debug_zval|ReflectionClass|Reflection|token_get_all|zend\.|declare\(ticks|highlight_|php_strip|__halt_compiler/i.test(s.FILE)) { results.skip.push(file); return; }
  const dir = path.join(work, String(idx++)); fs.mkdirSync(dir);
  const name = path.basename(file).replace(/\.phpt$/, '.php');
  fs.writeFileSync(path.join(dir, name), s.FILE, 'latin1');
  const ini = ['-d', 'display_errors=1', '-d', 'log_errors=0', '-d', 'error_reporting=32767', '-d', 'html_errors=0'];
  if (s.INI) for (const l of s.INI.split('\n')) { const t = l.trim(); if (t && !t.startsWith(';')) ini.push('-d', t); }
  if (s.SKIPIF) {
    fs.writeFileSync(path.join(dir, 'skip.php'), s.SKIPIF, 'latin1');
    const r = await run('php', [...ini, 'skip.php'], dir, 10000);
    if (/^\s*skip/i.test(r.out)) { results.skip.push(file); return; }
  }
  const [a, b] = await Promise.all([run('php', [...ini, name], dir, 20000), run('node', [NIP, ...ini, name], dir, 30000)]);
  if (a.killed) { results.skip.push(file); return; }
  if (b.killed) { results.timeout.push(file); return; }
  if (a.out === b.out && a.code === b.code) results.pass.push(file);
  else { results.fail.push(file); if (show) console.log('=== FAIL ' + file + '\n--- php (' + a.code + ')\n' + a.out.slice(0, 3000) + '\n--- phpjs (' + b.code + ')\n' + b.out.slice(0, 3000)); }
}
(async () => {
  const filtered = files.filter((f) => !filter || filter.test(f));
  let next = 0;
  const workers = Array.from({ length: jobs }, async () => { while (next < filtered.length) { const f = filtered[next++]; try { await one(f); } catch (e) { results.fail.push(f); } } });
  await Promise.all(workers);
  console.log(`pass=${results.pass.length} fail=${results.fail.length} timeout=${results.timeout.length} skip=${results.skip.length}`);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  fs.rmSync(work, { recursive: true, force: true });
})();
