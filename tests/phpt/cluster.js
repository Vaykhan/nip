// Re-runs failing tests and clusters them by the first differing output line.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const [resFile, outFile] = process.argv.slice(2);
const res = JSON.parse(fs.readFileSync(resFile));
function sections(src) { const out = {}; let cur = null; for (const line of src.split('\n')) { const m = /^--([A-Z_]+)--\s*$/.exec(line); if (m) { cur = m[1]; out[cur] = []; continue; } if (cur) out[cur].push(line); } for (const k of Object.keys(out)) out[k] = out[k].join('\n'); return out; }
const list = res.fail;
const recs = [];
let next = 0;
const NIP = path.resolve(__dirname, '../../bin/nip.js');
function run(cmd, args, cwd) { return new Promise((r) => { cp.execFile(cmd, args, { cwd, encoding: 'latin1', timeout: 30000, maxBuffer: 1 << 24 }, (e, so, se) => r((so || '') + (se || ''))); }); }
async function worker() {
  while (next < list.length) {
    const file = list[next++];
    const s = sections(fs.readFileSync(file, 'latin1'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')); const name = path.basename(file).replace(/\.phpt$/, '.php');
    fs.writeFileSync(path.join(dir, name), s.FILE, 'latin1');
    const ini = ['-d', 'display_errors=1', '-d', 'log_errors=0', '-d', 'error_reporting=32767', '-d', 'html_errors=0'];
    if (s.INI) for (const l of s.INI.split('\n')) { const t = l.trim(); if (t && !t.startsWith(';')) ini.push('-d', t); }
    const [a, b] = await Promise.all([run('php', [...ini, name], dir), run('node', [NIP, ...ini, name], dir)]);
    const A = a.split('\n'), Bl = b.split('\n');
    let i = 0; while (i < A.length && i < Bl.length && A[i] === Bl[i]) i++;
    recs.push({ file, php: (A[i] || '').slice(0, 200), js: (Bl[i] || '').slice(0, 200) });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(async () => {
  await Promise.all(Array.from({ length: 4 }, worker));
  const norm = (x) => x.replace(/\/tmp\/cl-\w+\/[\w.-]+/g, 'F').replace(/\d+/g, 'N').replace(/"[^"]*"/g, '"S"').slice(0, 90);
  const groups = new Map();
  for (const r of recs) { const k = 'JS: ' + norm(r.js) + ' | PHP: ' + norm(r.php); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r.file); }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  fs.writeFileSync(outFile, JSON.stringify(recs, null, 1));
  for (const [k, v] of sorted.slice(0, 70)) console.log(String(v.length).padStart(4), k, '  e.g.', path.basename(v[0]));
})();
