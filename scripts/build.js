#!/usr/bin/env node
// Builds dist/nip.cjs: the whole interpreter as one dependency-free CommonJS file.
//
// The source modules were designed so that concatenating them in MODULES order (with imports and
// `export` keywords removed) gives a valid script: top-level names are unique across src/, and no
// module needs another one that comes later while it is being evaluated. The build checks the
// first property; `npm test` runs the test suite against the bundle to check the second.
//
// Usage: node scripts/build.js [output path]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'nip.cjs'));

// Evaluation order of the bundle.
const MODULES = [
  'values.js', 'convert.js', 'compare.js', 'arith.js', 'utf8.js', 'lexer.js', 'parser.js',
  'compiler/common.js', 'compiler/ast-export.js', 'compiler/checks.js', 'compiler/lvalue.js', 'compiler/expr.js', 'compiler/stmt.js', 'compiler/generator.js',
  'runtime/state.js', 'runtime/version.js', 'runtime/errors.js', 'runtime/functions.js', 'runtime/callables.js', 'runtime/arginfo.js', 'runtime/inheritance.js', 'runtime/classes.js',
  'runtime/gc.js', 'runtime/generators.js', 'runtime/fibers.js', 'runtime/program.js',
  'lib/core.js', 'lib/dump.js', 'lib/printf.js', 'lib/string.js', 'lib/hash.js', 'lib/mbstring.js', 'lib/math.js',
  'lib/array.js', 'lib/var.js', 'lib/functions.js', 'lib/errors.js', 'lib/output.js', 'lib/json.js',
  'lib/serialize.js', 'lib/regex.js', 'lib/pcre.js', 'lib/date.js', 'lib/file.js',
  'runtime/native-classes.js', 'prelude.js', 'runtime/constants.js', 'lib/misc.js', 'lib/crypt.js', 'lib/reflection.js',
  'runtime/boot.js', 'runtime/run.js', 'cli.js', 'index.js',
];
// Modules that only import others; they contain no code of their own.
const IMPORT_ONLY = new Set(['lib/index.js']);

function listSources(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listSources(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const missing = listSources(SRC).filter((m) => !MODULES.includes(m) && !IMPORT_ONLY.has(m));
if (missing.length) throw new Error(`build: add these modules to MODULES in scripts/build.js: ${missing.join(', ')}`);

const nodeImports = new Map(); // local name -> specifier
const declared = new Map(); // top-level name -> module
const parts = [];

for (const mod of MODULES) {
  let code = fs.readFileSync(path.join(SRC, mod), 'utf8');
  code = code.replace(/^import (\w+) from '(node:[\w/]+)';\n/gm, (_, local, spec) => {
    if (nodeImports.has(local) && nodeImports.get(local) !== spec) throw new Error(`build: ${local} imported from two modules`);
    nodeImports.set(local, spec);
    return '';
  });
  code = code.replace(/^import \{[^}]*\} from '\.[^']*';\n/gm, '').replace(/^import '\.[^']*';\n/gm, '');
  code = code.replace(/^export \{[^}]*\} from '\.[^']*';\n/gm, '');
  if (/^(import|export \{)/m.test(code)) throw new Error(`build: unsupported import/export form in ${mod}`);
  code = code.replace(/^export (?=(?:async )?function|class |const |let )/gm, '');
  if (mod === 'prelude.js') code = inlinePrelude(code);
  if (/import\.meta/.test(code)) throw new Error(`build: import.meta used in ${mod}`);
  for (const name of topLevelNames(code)) {
    if (declared.has(name)) throw new Error(`build: ${name} is declared in both ${declared.get(name)} and ${mod}`);
    declared.set(name, mod);
  }
  parts.push(`// ---- src/${mod}\n${code.replace(/\n+$/, '')}\n`);
}

// names declared at the top level of a module: functions, classes, and every name of
// `const a = 1, b = 2` / `let a, b` declarations (on the first line of the declaration)
function topLevelNames(code) {
  const names = [];
  for (const m of code.matchAll(/^(?:async )?(?:function\*?|class) +([\w$]+)/gm)) names.push(m[1]);
  for (const m of code.matchAll(/^(?:const|let) +(.*)$/gm)) {
    let depth = 0, quote = null, start = true;
    const line = m[1];
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '/' && line[i + 1] === '/') break;
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) { start = true; continue; }
      else if (c === ';' && depth === 0) break;
      if (start && depth === 0) {
        const id = /^\s*([A-Za-z_$][\w$]*)/.exec(line.slice(i));
        if (id) { names.push(id[1]); i += id[0].length - 1; }
        start = false;
      }
    }
  }
  return names;
}

function inlinePrelude(code) {
  const files = {};
  for (const f of fs.readdirSync(path.join(SRC, 'prelude')).sort()) files[f] = fs.readFileSync(path.join(SRC, 'prelude', f), 'latin1');
  const out = code
    .replace(/^const PRELUDE_DIR = .*\n/m, '')
    .replace(/^function readPrelude\(name\) \{.*\}\n/m, `const PRELUDE_FILES = ${JSON.stringify(files)};\nfunction readPrelude(name) { return PRELUDE_FILES[name]; }\n`);
  if (out.includes('PRELUDE_DIR') || !out.includes('PRELUDE_FILES')) throw new Error('build: could not inline src/prelude/*.php');
  return out;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const header = `#!/usr/bin/env node
/*
 * NIP ${pkg.version} (Nip is php): a PHP 8.3 interpreter for Node.js, as a single file.
 * Generated by scripts/build.js from src/ — edit the sources, not this file.
 *
 *   node nip.cjs script.php [args...]          const { run } = require('./nip.cjs');
 *   node nip.cjs -r 'echo "hi\\n";'             run('<?php echo "hi";').output
 */
'use strict';

// CLI fast path: the main thread only starts a worker thread with a large stack (so deep PHP
// recursion works) and returns without initializing the interpreter itself.
if (require.main === module) {
  try { require('node:module').enableCompileCache?.(); } catch (e) { /* optional */ }
  const wt = require('node:worker_threads');
  if (wt.isMainThread && !process.env.NIP_NO_WORKER) {
    let w = null;
    try {
      w = new wt.Worker(__filename, { argv: process.argv.slice(2), resourceLimits: { stackSizeMb: 256, maxOldGenerationSizeMb: 4096 }, stdout: false, stderr: false, stdin: false });
    } catch (e) { w = null; }
    if (w) {
      w.on('message', (m) => { if (m && m.exit !== undefined) process.exitCode = m.exit; });
      w.on('error', (e) => { process.stderr.write('PHP Fatal error:  ' + ((e && e.stack) || e) + '\\n'); process.exitCode = 255; });
      w.on('exit', () => { process.exit(process.exitCode || 0); });
      return;
    }
  }
}

${[...nodeImports].map(([local, spec]) => `const ${local} = require('${spec}');`).join('\n')}

`;
const footer = `
module.exports = { run, runFile, cliMain };

if (require.main === module) {
  const { isMainThread, parentPort } = require('node:worker_threads');
  const code = main(process.argv.slice(2));
  if (!isMainThread) parentPort.postMessage({ exit: code });
  else process.exitCode = code;
}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + parts.join('\n') + footer, { mode: 0o755 });
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${MODULES.length} modules)`);
