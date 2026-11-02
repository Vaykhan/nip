// prints compact diffs for failing tests listed in a results json
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const [resFile, startArg, countArg] = process.argv.slice(2);
const res = JSON.parse(fs.readFileSync(resFile));
// result files list test names relative to the php-src checkout
const root = path.resolve(process.env.PHPSRC || '/tmp/php-src');
const abs = (t) => path.resolve(root, t);
const list = res.fail.concat(res.timeout || []);
const start = +startArg || 0, count = +countArg || 10;
function sections(src) { const out = {}; let cur = null; for (const line of src.split('\n')) { const m = /^--([A-Z_]+)--\s*$/.exec(line); if (m) { cur = m[1]; out[cur] = []; continue; } if (cur) out[cur].push(line); } for (const k of Object.keys(out)) out[k] = out[k].join('\n'); return out; }
for (const file of list.slice(start, start + count)) {
  const s = sections(fs.readFileSync(abs(file), 'latin1'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')); const name = path.basename(file).replace(/\.phpt$/, '.php');
  fs.writeFileSync(path.join(dir, name), s.FILE, 'latin1');
  const ini = ['-d', 'display_errors=1', '-d', 'log_errors=0', '-d', 'error_reporting=32767', '-d', 'html_errors=0'];
  if (s.INI) for (const l of s.INI.split('\n')) { const t = l.trim(); if (t && !t.startsWith(';')) ini.push('-d', t); }
  const r1 = cp.spawnSync('php', [...ini, name], { cwd: dir, encoding: 'latin1', timeout: 20000 });
  const r2 = cp.spawnSync('node', [path.resolve(__dirname, '../../bin/nip.js'), ...ini, name], { cwd: dir, encoding: 'latin1', timeout: 30000 });
  const a = (r1.stdout + r1.stderr).split('\n'), b = (r2.stdout + r2.stderr).split('\n');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.log(`=== ${file} (line ${i})`);
  console.log('  php : ' + a.slice(i, i + 4).join('\n        ').slice(0, 600));
  console.log('  js  : ' + b.slice(i, i + 4).join('\n        ').slice(0, 600));
}
