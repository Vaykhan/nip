// Running a script: superglobals, top-level error handling, shutdown sequence.

import tty from 'node:tty';
import { ExitSig, FatalSig, mkf, ParseErr, PHPArray, Ref } from '../values.js';
import { toStr } from '../convert.js';
import { utf8Encode } from '../utf8.js';
import { Frame } from '../compiler/common.js';
import { rt } from './state.js';
import { toThrowSig, writeErr } from './errors.js';
import { callNative, NativeFrame } from './functions.js';
import { callValue } from './callables.js';
import { gcShutdown } from './gc.js';
import { closeFibers } from './fibers.js';
import { compileSource, runProgram } from './program.js';
import { deref } from '../lib/core.js';
import { INI_DEFAULTS } from '../lib/errors.js';
import { obApply, obEmit } from '../lib/output.js';
import { boot, resetRuntime } from './boot.js';

function formatUncaught(obj) {
  let s;
  try { s = toStr(obj); } catch (e) { s = obj.cls.name; }
  const file = deref(obj.props.get('file')), line = deref(obj.props.get('line'));
  return `Uncaught ${s}\n  thrown in ${file} on line ${line}`;
}
function handleTopLevel(e) {
  if (e instanceof ExitSig) return e.code;
  if (e instanceof FatalSig) {
    rt.flush();
    const kind = e.kind || 'Fatal error';
    writeErr(`${kind}: ${e.msg} in ${e.file || rt.file} on line ${e.line || rt.line}`);
    return 255;
  }
  if (e instanceof ParseErr) { writeErr(`Parse error: ${e.msg} in ${rt.file} on line ${e.line}`); return 255; }
  const sig = toThrowSig(e);
  if (sig) {
    if (rt.exceptionHandlers.length) {
      const h = rt.exceptionHandlers.pop();
      try { callValue(h, [sig.obj]); return 0; } catch (e2) { return handleTopLevel(e2); }
    }
    rt.flush();
    if (sig.obj.cls.lname === 'parseerror') writeErr(`Parse error: ${toStr(deref(sig.obj.props.get('message')))} in ${deref(sig.obj.props.get('file'))} on line ${deref(sig.obj.props.get('line'))}`);
    else writeErr(`Fatal error: ${formatUncaught(sig.obj)}`);
    return 255;
  }
  throw e;
}

// A value as PHP's INI parser reads it (-d, php.ini): On/Off/Yes/No/True/False/None/Null,
// quoted strings, ${ENV} variables, and values starting with a constant: the constant's value, or
// an expression of constants and numbers with | & ^ ~ ! and parentheses
function iniValue(raw) {
  let v = String(raw).trim();
  if (/^(on|yes|true)$/i.test(v)) return '1';
  if (/^(off|no|false|none|null)$/i.test(v)) return '';
  v = v.replace(/\$\{([^}]*)\}/g, (m, name) => process.env[name] ?? '');
  if (/^"[^"]*"/.test(v) || /^'[^']*'$/.test(v)) return v.replace(/"([^"]*)"/g, '$1').replace(/^'(.*)'$/, '$1');
  if (!/^[A-Za-z_]/.test(v)) return v;
  const tokens = v.match(/\s+|[A-Za-z_][A-Za-z0-9_]*|\d+|[|&^~!()]|./g) || [];
  const operand = (t) => (/^\d+$/.test(t) ? Number(t) : rt.consts.has(t) ? rt.consts.get(t) : undefined);
  // expression?
  const ts = tokens.filter((t) => !/^\s+$/.test(t));
  let pos = 0;
  const unary = () => {
    const t = ts[pos];
    if (t === '~') { pos++; return ~unary(); }
    if (t === '!') { pos++; return unary() ? 0 : 1; }
    if (t === '(') { pos++; const r = binary(); if (ts[pos++] !== ')') throw 0; return r; }
    const o = t === undefined ? undefined : operand(t);
    if (typeof o !== 'number') throw 0;
    pos++;
    return o;
  };
  const binary = () => {
    let r = unary();
    while (ts[pos] === '|' || ts[pos] === '&' || ts[pos] === '^') {
      const op = ts[pos++], b = unary();
      r = op === '|' ? r | b : op === '&' ? r & b : r ^ b;
    }
    return r;
  };
  try { const r = binary(); if (pos === ts.length) return String(r); } catch (e) { /* not an expression */ }
  return tokens.map((t) => (/^[A-Za-z_]/.test(t) && rt.consts.has(t) ? toStr(rt.consts.get(t)) : t)).join('');
}

// disable_functions (startup-only ini): listed builtins behave as if they didn't exist
function disableFunctions(list) {
  rt.disabledFns = null;
  if (!list) return;
  rt.disabledFns = new Set(String(list).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  for (const name of rt.disabledFns) rt.fns.delete(name);
}

export function runScript(code, file, argv, opts = {}) {
  boot();
  resetRuntime();
  if (opts.ini) for (const [k, raw] of Object.entries(opts.ini)) { const v = iniValue(raw); if (!(k in INI_DEFAULTS)) rt.ini.set(k, v); callNative(rt.fns.get('ini_set'), [k, v]); }
  disableFunctions(rt.ini.get('disable_functions'));
  if (opts.capture) rt.capture = [];
  try { rt.ttyOut = !opts.capture && tty.isatty(1); } catch (e) { rt.ttyOut = false; }
  const args = PHPArray.from(argv.map((a) => utf8Encode(a)));
  const g = rt.globals;
  g.argv = new Ref(args); g.argc = new Ref(argv.length);
  const server = new PHPArray();
  for (const [k, v] of Object.entries(process.env)) server.set(k, utf8Encode(v));
  const now = Date.now();
  for (const [k, v] of [['PHP_SELF', file], ['SCRIPT_NAME', file], ['SCRIPT_FILENAME', file], ['PATH_TRANSLATED', file], ['DOCUMENT_ROOT', ''], ['REQUEST_TIME', Math.floor(now / 1000)], ['REQUEST_TIME_FLOAT', mkf(now / 1000)], ['argv', args.clone()], ['argc', argv.length]]) server.set(k, v);
  g._SERVER = new Ref(server);
  for (const n of ['_GET', '_POST', '_COOKIE', '_FILES', '_REQUEST', '_ENV', '_SESSION']) g[n] = new Ref(new PHPArray());
  const f = new Frame(null, null, null, null);
  f.vars = g;
  rt.globalFrame = f; rt.frame = f; rt.file = file; rt.line = 0; rt.mainFile = file;
  let exitCode = 0;
  try {
    const prog = compileSource(code, file);
    rt.mainStrict = false;
    if (opts.lint) { rt.flush(); return { exitCode: 0, output: '' }; }
    runProgram(prog, f);
  } catch (e) {
    exitCode = handleTopLevel(e);
  }
  // shutdown sequence
  try {
    for (let i = 0; i < rt.shutdownFns.length; i++) { const [cb, a] = rt.shutdownFns[i]; callValue(cb, a); }
  } catch (e) { exitCode = handleTopLevel(e); }
  try { closeFibers(); } catch (e) { exitCode = handleTopLevel(e); }
  try {
    gcShutdown();
  } catch (e) { exitCode = handleTopLevel(e); }
  // flush remaining output buffers; a callback that throws loses its buffer. An exception handled
  // by a user exception handler at this point doesn't change the exit status (as in PHP).
  while (rt.obStack.length) {
    const ob = rt.obStack.pop();
    const internal = new NativeFrame({ name: '', isMethod: false }, []); internal.hidden = true;
    rt.stack.push(internal);
    try { obEmit(obApply(ob, ob.buf, 8)); }
    catch (e) { const handled = rt.exceptionHandlers.length > 0 && toThrowSig(e); const code = handleTopLevel(e); if (!handled) exitCode = code; }
    finally { rt.stack.pop(); }
  }
  rt.flush();
  const out = rt.capture ? rt.capture.join('') : null;
  rt.capture = null;
  return { exitCode, output: out };
}
