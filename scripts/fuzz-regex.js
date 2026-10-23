// Differential fuzzing of preg_* against the reference `php`: random patterns from a small
// grammar (groups, quantifiers, lookarounds, backreferences, conditionals, verbs, ...) and
// random subjects, run through preg_match_all, preg_replace and preg_split by both.
//
//   node scripts/fuzz-regex.js [--seed N] [--count N]     (needs `php` on PATH)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? +args[i + 1] : def; };
let seed = opt('--seed', 1) >>> 0;
const count = opt('--count', 1000);
const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const pick = (a) => a[rnd(a.length)];

const ZERO_WIDTH = ['^', '$', '\\b', '\\B', '\\A', '\\z', '\\Z', '(?i)', '\\K', '(*SKIP)'];
function atom(d) {
  switch (rnd(d > 2 ? 10 : 25)) {
    case 0: case 1: case 2: case 3: case 7: case 8: case 9: return pick(['a', 'b', 'c', 'x']);
    case 4: return '.';
    case 5: return pick(['[ab]', '[^a]', '[a-c]', '\\d', '\\w', '\\s', '[[:alpha:]]']);
    case 6: return pick(ZERO_WIDTH.slice(0, 7));
    case 10: case 11: return '(' + alt(d + 1) + ')';
    case 12: return '(?:' + alt(d + 1) + ')';
    case 13: return '(?=' + alt(d + 1) + ')';
    case 14: return '(?!' + alt(d + 1) + ')';
    case 15: return '(?<=' + pick(['a', 'b', 'ab', 'a|bc', '[ab]']) + ')';
    case 16: return '(?<!' + pick(['a', 'b', 'ab', 'a|bc']) + ')';
    case 17: return '(?>' + alt(d + 1) + ')';
    case 18: return '\\1';
    case 19: return '(?<n' + rnd(3) + '>' + alt(d + 1) + ')';
    case 20: return '(?i)';
    case 21: return '(?(1)' + seq(d + 1) + '|' + seq(d + 1) + ')';
    case 22: return '(?|(a)|(b))';
    case 23: return '\\K';
    default: return '(*SKIP)';
  }
}
const quant = (a) => { const q = pick(['', '', '', '', '*', '+', '?', '{1,2}', '{2}', '*?', '+?', '*+', '++']); return ZERO_WIDTH.includes(a) ? a : a + q; };
function seq(d) { let s = ''; for (let n = 1 + rnd(4); n > 0; n--) s += quant(atom(d)); return s; }
function alt(d) { let s = seq(d); if (rnd(4) === 0) s += '|' + seq(d); return s; }

const cases = [];
for (let i = 0; i < count; i++) {
  let subj = '';
  for (let n = rnd(9); n > 0; n--) subj += pick(['a', 'b', 'c', 'x', 'A', '1', ' ', '\n']);
  cases.push(['/' + alt(0) + '/' + pick(['', '', 'i', 'm', 's', 'x', 'U']), subj]);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-regex-'));
fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases));
fs.writeFileSync(path.join(dir, 'run.php'), `<?php
foreach (json_decode(file_get_contents(__DIR__ . '/cases.json')) as [$p, $s]) {
  error_clear_last();
  $r = @preg_match_all($p, $s, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE);
  $e = error_get_last();
  echo json_encode([$p, $s, $r, $m, @preg_replace($p, '<$0>', $s), @preg_split($p, $s, -1, PREG_SPLIT_DELIM_CAPTURE), $e ? preg_replace('/ in .*$/', '', $e['message']) : null]), "\\n";
}
`);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const run = (cmd, a) => cp.execFileSync(cmd, a, { encoding: 'latin1', maxBuffer: 1 << 28 }).split('\n');
const php = run('php', [path.join(dir, 'run.php')]), nip = run('node', [path.join(root, 'bin/nip.js'), path.join(dir, 'run.php')]);
let bad = 0;
for (let i = 0; i < php.length; i++) {
  if (php[i] === nip[i]) continue;
  if (++bad <= 10) console.log(`--- php\n${php[i]}\n--- nip\n${nip[i]}`);
}
fs.rmSync(dir, { recursive: true });
console.log(`${bad} of ${count} cases differ`);
process.exitCode = bad ? 1 : 0;
