// Raising warnings/notices/deprecations, throwing PHP exceptions, stack traces.

import { FatalSig, Flt, fmtRepr, isInt, PHPArray, PHPObject, Ref, ThrowSig } from '../values.js';
import { toInt } from '../convert.js';
import {
  E_COMPILE_WARNING, E_CORE_WARNING, E_DEPRECATED, E_NOTICE, E_PARSE, E_STRICT, E_USER_DEPRECATED,
  E_USER_NOTICE, E_USER_WARNING, E_WARNING, rt, writeFd
} from './state.js';
import { callValue } from './callables.js';
import { initProps, lookupClass } from './classes.js';

function errorTypeName(type) {
  switch (type) {
    case E_WARNING: case E_USER_WARNING: case E_CORE_WARNING: case E_COMPILE_WARNING: return 'Warning';
    case E_NOTICE: case E_USER_NOTICE: return 'Notice';
    case E_DEPRECATED: case E_USER_DEPRECATED: return 'Deprecated';
    case E_STRICT: return 'Strict Standards';
    case E_PARSE: return 'Parse error';
    default: return 'Fatal error';
  }
}

// display an error: "Warning: msg in file on line N" (file undefined: no location), as HTML with
// html_errors (docref_root adds a manual link to function errors)
export function writeErr(kind, msg, file, line) {
  rt.flush();
  const loc = file === undefined ? '' : ` in ${file} on line ${line}`;
  if (rt.displayErrors === 'stdout') {
    const ini = (k) => rt.ini.get(k) || '';
    if (iniBool('html_errors', false)) {
      if (kind === 'Fatal error') msg = msg.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      const root = ini('docref_root');
      if (root) msg = msg.replace(/^([A-Za-z_][\w]*)\(([^)]*)\): /, (m, fn, params) => { const ref = 'function.' + fn.toLowerCase().replace(/_/g, '-') + ini('docref_ext'); return `${fn}(${params}) [<a href='${root}${ref}'>${ref}</a>]: `; });
      const hloc = file === undefined ? '' : ` in <b>${file}</b> on line <b>${line}</b>`;
      rt.echo(`${ini('error_prepend_string')}<br />\n<b>${kind}</b>:  ${msg}${hloc}<br />\n${ini('error_append_string')}`);
    } else rt.echo(`${ini('error_prepend_string')}\n${kind}: ${msg}${loc}\n${ini('error_append_string')}`);
  } else if (rt.capture) rt.capture.push(`\nPHP ${kind}: ${msg}${loc}\n`);
  else writeFd(2, Buffer.from(`PHP ${kind}:  ${msg}${loc}\n`, 'latin1'));
}

export function raise(type, msg) {
  const [file, line] = userLocation();
  rt.lastError = { type, message: msg, file, line };
  // user error handler
  if (rt.errorHandlers.length && !rt.inHandler) {
    const h = rt.errorHandlers[rt.errorHandlers.length - 1];
    if (h.handler !== null && (h.mask & type)) {
      rt.inHandler = true;
      let r;
      try { r = callValue(h.handler, [type, msg, file, line]); }
      finally { rt.inHandler = false; }
      if (r !== false) return;
    }
  }
  if (rt.silence) return;
  if (!(rt.errorReporting & type)) return;
  if (rt.displayErrors === '0' || rt.displayErrors === 'off') return;
  writeErr(errorTypeName(type), msg, file, line);
}
export function warn(msg) { raise(E_WARNING, msg); }
export function notice(msg) { raise(E_NOTICE, msg); }
export function deprecated(msg) { raise(E_DEPRECATED, msg); }

export function throwError(clsName, msg, code) {
  const cls = rt.classes.get(clsName.toLowerCase());
  if (!cls) throw new FatalSig(msg);
  const obj = new PHPObject(cls);
  initProps(obj);
  initThrowable(obj);
  obj.props.set('message', msg);
  if (code !== undefined) obj.props.set('code', code);
  throw new ThrowSig(obj);
}
// zend_exception_set_previous: prev goes at the end of obj's chain of previous exceptions
export function setPrevious(obj, prev) {
  if (!prev || obj === prev) return;
  let cur = obj;
  for (let n = 0; n < 10000; n++) {
    let p = cur.props.get('previous');
    if (p instanceof Ref) p = p.v;
    if (p === prev) return;
    if (!(p instanceof PHPObject)) { cur.props.set('previous', prev); return; }
    cur = p;
  }
}
export function makeException(clsName, msg) {
  const cls = lookupClass(clsName);
  const obj = new PHPObject(cls);
  initProps(obj);
  initThrowable(obj);
  obj.props.set('message', msg);
  return obj;
}

export function toThrowSig(e) {
  if (e instanceof ThrowSig) return e;
  if (e instanceof RangeError && /call stack/i.test(e.message)) {
    try { throwError('Error', 'Maximum call stack size reached. Infinite recursion?'); } catch (s) { return s; }
  }
  return null;
}

// trace capture
export function captureTrace(withArgs) {
  const tr = new PHPArray();
  const st = rt.stack;
  for (let i = st.length - 1; i >= 0; i--) {
    const s = st[i];
    if (s.hidden) continue; // marks engine-internal callers (see runScript's shutdown)
    const fromPrelude = s.callFile === PRELUDE_FILE;
    if (fromPrelude && (s.native === true || (s.fn && s.fn.file === PRELUDE_FILE))) continue;
    const fr = new PHPArray();
    const calledFromNative = (i > 0 && st[i - 1].native === true) || fromPrelude;
    if (!calledFromNative) { fr.set('file', s.callFile); fr.set('line', s.callLine); }
    fr.set('function', s.fn.isClosure ? '{closure}' : s.fn.name);
    // (an anonymous class's name is printed up to its NUL byte)
    if (s.fn.isMethod && (s.cls || s.this)) { fr.set('class', (s.fn.cls || s.cls || s.this.cls).name.split('\0')[0]); fr.set('type', s.this ? '->' : '::'); }
    if (withArgs !== false) {
      const a = s.args || [];
      fr.set('args', PHPArray.from(Array.from(a, (x) => (x instanceof Ref ? x.v : x))));
    }
    tr.push(fr);
  }
  return tr;
}
// Code in src/prelude/*.php runs as if it were internal: errors raised there are reported at
// the user's call site, and calls between prelude functions don't appear in traces.
// set_time_limit()/max_execution_time: loops check the deadline every few thousand iterations
let timeTicks = 0;
export function checkTimeLimit() {
  if (++timeTicks < 4096) return;
  timeTicks = 0;
  if (Date.now() > rt.deadline) {
    const n = rt.timeLimit;
    rt.deadline = 0;
    throw new FatalSig(`Maximum execution time of ${n} second${n === 1 ? '' : 's'} exceeded`, rt.line, rt.file);
  }
}
export function setTimeLimit(n) { rt.timeLimit = n; rt.deadline = n > 0 ? Date.now() + n * 1000 : 0; }
export const PRELUDE_FILE = 'prelude.php';
export function userLocation() {
  if (rt.file !== PRELUDE_FILE) return [rt.file, rt.line];
  const st = rt.stack;
  for (let i = st.length - 1; i >= 0; i--) if (st[i].callFile && st[i].callFile !== PRELUDE_FILE) return [st[i].callFile, st[i].callLine];
  return [rt.file, rt.line];
}
export function initThrowable(obj) {
  const [file, line] = userLocation();
  obj.props.set('file', file);
  obj.props.set('line', line);
  obj.trace = captureTrace(iniBool('zend.exception_ignore_args', true) ? false : true);
}
function iniBool(k, def) { const v = rt.ini.get(k); if (v === undefined) return def; return /^(1|on|true|yes)$/i.test(String(v)); }
function traceArgStr(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (isInt(v)) return String(v);
  if (v instanceof Flt) return fmtRepr(v.v);
  if (typeof v === 'string') { const max = toInt(rt.ini.get('zend.exception_string_param_max_len') ?? '0'); return "'" + (v.length > max ? v.slice(0, max) + '...' : v) + "'"; }
  if (v instanceof PHPArray) return 'Array';
  if (v instanceof PHPObject) return 'Object(' + v.cls.name + ')';
  return 'Resource id #' + v.id;
}
export function traceAsString(trace) {
  let s = '', i = 0;
  for (const fr of trace.values()) {
    const cls = fr.get('class'), type = fr.get('type');
    const args = fr.get('args');
    const a = args instanceof PHPArray ? args.values().map(traceArgStr).join(', ') : '';
    const loc = fr.has('file') ? `${fr.get('file')}(${fr.get('line')})` : '[internal function]';
    s += `#${i++} ${loc}: ${cls ? cls + type : ''}${fr.get('function')}(${a})\n`;
  }
  return s + `#${i} {main}`;
}
