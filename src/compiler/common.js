// Compiler shared pieces: control signals, warnings, array/string element reads.
// The compiler turns each AST node into a JS closure; see expr.js, lvalue.js and stmt.js.

import { Flt, INT_LIKE, KEY_ISSET, normKey, NUM_LEAD, PHPArray, PHPObject, Ref } from '../values.js';
import { floatToInt, toBool, toInt, toStr, typeOf, valueName } from '../convert.js';
import { LVAL_KINDS } from '../parser.js';
import { deprecated, throwError, warn } from '../runtime/errors.js';
import { callMethodName } from '../runtime/classes.js';

export const BREAK1 = { t: 1, n: 1 }, CONT1 = { t: 2, n: 1 }, RETURN = { t: 3 };
export const mkBreak = (n) => (n === 1 ? BREAK1 : { t: 1, n });
export const mkCont = (n) => (n === 1 ? CONT1 : { t: 2, n });
export const SUPERGLOBALS = new Set(['_SERVER', '_GET', '_POST', '_ENV', '_COOKIE', '_FILES', '_REQUEST', '_SESSION']);

function Vars() {}
Vars.prototype = Object.create(null);
export class Frame {
  constructor(fn, thisObj, cls, sc) {
    this.vars = new Vars();
    this.fn = fn; this.this = thisObj; this.cls = cls; this.sc = sc;
    this.ret = null; this.args = null; this.temps = null; this.statics = null; this.closure = null;
    this.callLine = 0; this.callFile = ''; this.retRef = null; this.destr = null; this.gen = null;
  }
}

export function isFresh(n) { // expressions producing a new value (no copy marking needed)
  switch (n.k) {
    case 'Lit': case 'Interp': case 'Bin': case 'New': case 'Not': case 'Neg': case 'Cast': case 'Isset': case 'Empty': case 'Closure': return true;
    case 'Arr': return true;
  }
  return false;
}
export const isLvalNode = (n) => LVAL_KINDS.has(n.k);

// in fiber mode (see compiler/generator.js) every call to user code may suspend
export const CALL_KINDS = new Set(['Call', 'MCall', 'SCall']);
export function hasSuspend(n) {
  if (n === null || typeof n !== 'object') return false;
  if (n._hs !== undefined) return n._hs;
  let r = false;
  if (CALL_KINDS.has(n.k) || n.k === 'Yield' || n.k === 'YieldFrom') r = true;
  else if (n.k === 'Closure' || n.k === 'ClassDecl' || n.k === 'FuncDecl') r = false;
  else if (Array.isArray(n)) r = n.some(hasSuspend);
  else {
    for (const key in n) {
      if (key === 'l' || key === '_hy' || key === '_hs') continue;
      const v = n[key];
      if (v && typeof v === 'object' && hasSuspend(v)) { r = true; break; }
    }
  }
  if (!Array.isArray(n)) n._hs = r;
  return r;
}
export function hasYield(n) {
  if (n === null || typeof n !== 'object') return false;
  if (n._hy !== undefined) return n._hy;
  let r = false;
  if (n.k === 'Yield' || n.k === 'YieldFrom') r = true;
  else if (n.k === 'Closure' || n.k === 'ClassDecl' || n.k === 'FuncDecl') r = false;
  else if (Array.isArray(n)) r = n.some(hasYield);
  else {
    for (const key in n) {
      if (key === 'l' || key === '_hy' || key === '_hs') continue;
      const v = n[key];
      if (v && typeof v === 'object' && hasYield(v)) { r = true; break; }
    }
  }
  if (!Array.isArray(n)) n._hy = r;
  return r;
}

// collect variables used in an arrow function body (for auto-capture)
export function arrowFreeVars(fn) {
  const names = new Set();
  const params = new Set(fn.params.map((p) => p.name));
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.k === 'Var' && typeof n.name === 'string') { names.add(n.name); return; }
    if (n.k === 'Closure') {
      if (n.fn.arrow) { for (const v of arrowFreeVars(n.fn)) names.add(v); }
      else if (n.fn.uses) for (const u of n.fn.uses) names.add(u.name);
      for (const p of n.fn.params) if (p.def) walk(p.def);
      return;
    }
    if (n.k === 'ClassDecl') return;
    for (const key in n) if (key !== 'l' && key !== '_hy') { const v = n[key]; if (v && typeof v === 'object') walk(v); }
  };
  walk(fn.arrowExpr);
  for (const p of params) names.delete(p);
  names.delete('this');
  return [...names];
}

// ---------------------------------------------------------------- warnings helpers
export function warnUndefVar(name) { warn(`Undefined variable $${name}`); }
export function keyRepr(k) { return typeof k === 'string' ? `"${k}"` : String(k); }

// ---------------------------------------------------------------- array/string reads
export function readIndex(base, key, quiet) {
  if (base instanceof PHPArray) {
    const k = normKey(key, quiet ? KEY_ISSET : 0);
    const i = base.index(k);
    if (i === undefined) { if (!quiet) warn(`Undefined array key ${keyRepr(k)}`); return quiet ? undefined : null; }
    const v = base.v[i];
    return v instanceof Ref ? v.v : v;
  }
  if (typeof base === 'string') {
    let idx = strOffsetKey(key, quiet);
    if (idx === undefined) return undefined;
    const off = idx; // PHP reports the integer offset, before negative offsets are resolved
    if (typeof idx === 'bigint') idx = -1; // beyond 2^53: out of range for any string
    else if (idx < 0) idx += base.length;
    if (idx < 0 || idx >= base.length) { if (!quiet) warn(`Uninitialized string offset ${off}`); return quiet ? undefined : ''; }
    return base[idx];
  }
  if (base instanceof PHPObject) {
    if (base.cls.ancestors.has('arrayaccess')) {
      if (quiet) {
        if (!toBool(callMethodName(base, 'offsetExists', [key]))) return undefined;
      }
      return callMethodName(base, 'offsetGet', [key]);
    }
    throwError('Error', `Cannot use object of type ${base.cls.name} as array`);
  }
  if (base === null || base === undefined) { if (!quiet) warn('Trying to access array offset on null'); return quiet ? undefined : null; }
  if (!quiet) warn(`Trying to access array offset on ${valueName(base)}`);
  return quiet ? undefined : null;
}

// a string offset as an integer (zend_check_string_offset): integer strings, with a warning
// when followed by other characters; floats, bools and null with a warning. isset: undefined when
// it isn't one (without warnings).
const INT_LEAD = /^[ \t\n\r\v\f]*[+-]?\d+/;
export function strOffsetKey(key, isset) {
  if (typeof key === 'number' || typeof key === 'bigint') return key;
  if (typeof key === 'string') {
    if (INT_LIKE.test(key)) return toInt(key);
    const m = NUM_LEAD.exec(key);
    if (isset || !m || !INT_LEAD.test(key) || /[.eE]/.test(m[0])) {
      if (isset) return undefined;
      throwError('TypeError', 'Cannot access offset of type string on string');
    }
    warn(`Illegal string offset "${key}"`);
    return toInt(key);
  }
  if (key === null || key === undefined || typeof key === 'boolean' || key instanceof Flt) {
    if (!isset) warn('String offset cast occurred');
    return key instanceof Flt ? floatToInt(key.v) : key ? 1 : 0;
  }
  if (isset) return undefined;
  throwError('TypeError', `Cannot access offset of type ${typeOf(key)} on string`);
}
export let strOffsetChar = null;
export function strSetOffset(s, key, v) {
  let idx = strOffsetKey(key, false);
  if (typeof idx === 'bigint') idx = Number(idx);
  if (idx < 0) idx += s.length;
  if (idx < 0) { warn(`Illegal string offset ${toStr(key)}`); return s; }
  let c = toStr(v);
  if (c === '') throwError('Error', 'Cannot assign an empty string to a string offset');
  if (c.length > 1) { warn('Only the first byte will be assigned to the string offset'); c = c[0]; }
  strOffsetChar = c;
  if (idx >= s.length) s = s + ' '.repeat(idx - s.length) + c;
  else s = s.slice(0, idx) + c + s.slice(idx + 1);
  return s;
}

export function writableArrIn(ref) { // ensure ref.v is a writable array (autovivify)
  let v = ref.v;
  if (v instanceof PHPArray) { if (v.cow || v.fe) { v = ref.v = v.clone(); } return v; }
  if (v === null || v === undefined) return (ref.v = new PHPArray());
  if (v === false) { deprecated('Automatic conversion of false to array is deprecated'); return (ref.v = new PHPArray()); }
  if (v instanceof PHPObject) return v;
  if (typeof v === 'string' && v === '') throwError('Error', '[] operator not supported for strings');
  throwError('Error', 'Cannot use a scalar value as an array');
}
