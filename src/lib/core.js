// Builtin function registry (def/alias) and PHP 8 argument coercion helpers
// (S = string, I = int, N = int|float, B = bool, A = array, ...).

import { cp, Flt, fmtRepr, isInt, NUM_LEAD, numericStr, PHPArray, PHPObject, Ref } from '../values.js';
import { floatToInt, toDbl, toInt, toNumber, toStr, valueName } from '../convert.js';
import { isNum } from '../compare.js';
import { writableArrIn } from '../compiler/common.js';
import { E_DEPRECATED, rt } from '../runtime/state.js';
import { deprecated, throwError } from '../runtime/errors.js';
import { findMethod } from '../runtime/callables.js';

export function pnamesOf(fn) {
  const src = fn.toString();
  const m = /^[^(]*\(([^)]*)\)/.exec(src);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^\.\.\./, '').replace(/\s*=.*$/, '')).filter(Boolean).map((n) => n.replace(/^_/, ''));
}
export function def(name, fn, opts) {
  const o = opts || {};
  const src = fn.toString();
  const hasRest = /^[^(]*\([^)]*\.\.\./.test(src);
  const nparams = pnamesOf(fn).length;
  const entry = {
    name, native: fn, min: o.min !== undefined ? o.min : fn.length, max: o.max !== undefined ? o.max : (hasRest ? Infinity : nparams + (o.frame ? 0 : 0)),
    refs: o.refs || (o.refRest !== undefined ? [] : null), refRest: o.refRest !== undefined ? o.refRest : null, frame: !!o.frame, isMethod: false, params: null,
  };
  if (o.frame) { entry.min = Math.max(0, entry.min - 1); entry.max = entry.max === Infinity ? Infinity : Math.max(0, entry.max - 1); }
  Object.defineProperty(entry, 'pnames', { get() { const p = pnamesOf(fn); return o.frame ? p.slice(1) : p; } });
  rt.fns.set(name.toLowerCase(), entry);
  return entry;
}
export function alias(newName, old) { const e = rt.fns.get(old.toLowerCase()); rt.fns.set(newName.toLowerCase(), Object.assign(Object.create(Object.getPrototypeOf(e)), e, { name: newName })); }

// argument coercion helpers (PHP 8 builtin semantics)
function argTypeErr(expected, v) {
  const args = rt.nativeArgs || [];
  let idx = -1;
  for (let i = 0; i < args.length; i++) { const a = args[i] instanceof Ref ? args[i].v : args[i]; if (a === v) { idx = i; break; } }
  const fn = rt.fns.get((rt.nativeName || '').toLowerCase());
  const pn = fn && fn.pnames ? fn.pnames[idx] : null;
  const where = idx >= 0 ? `Argument #${idx + 1}${pn ? ' ($' + pn + ')' : ''}` : 'Argument';
  throwError('TypeError', `${rt.nativeName}(): ${where} must be of type ${expected}, ${valueName(v)} given`);
}
export function argPos(v) {
  const args = rt.nativeArgs || [];
  for (let i = 0; i < args.length; i++) { const a = args[i] instanceof Ref ? args[i].v : args[i]; if (a === v) return i; }
  return -1;
}
function nullArgDeprecation(type) {
  if (!(rt.errorReporting & E_DEPRECATED) && !rt.errorHandlers.length) return;
  const i = argPos(null);
  const fn = rt.fns.get((rt.nativeName || '').toLowerCase());
  const pn = fn && fn.pnames ? fn.pnames[i] : null;
  deprecated(`${rt.nativeName}(): Passing null to parameter #${i + 1}${pn ? ' ($' + pn + ')' : ''} of type ${type} is deprecated`);
}
// (strict_types: no coercion, except int to float)
export const S = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Ref) { v = v.v; if (typeof v === 'string') return v; }
  if (rt.nativeStrict) argTypeErr('string', v);
  if (v === null) { nullArgDeprecation('string'); return ''; }
  if (v instanceof PHPArray) argTypeErr('string', v);
  if (v instanceof PHPObject && !findMethod(v.cls, '__tostring')) argTypeErr('string', v);
  return toStr(v);
};
export const I = (v) => {
  if (typeof v === 'number') return v;
  if (rt.nativeStrict) { if (v instanceof Ref) v = v.v; if (isInt(v)) return v; argTypeErr('int', v); }
  if (v === null) { nullArgDeprecation('int'); return 0; }
  if (v instanceof Flt) {
    if (!isFinite(v.v) || v.v >= 9223372036854775808 || v.v < -9223372036854775808) argTypeErr('int', v);
    if (!Number.isInteger(v.v)) deprecated(`Implicit conversion from float ${fmtRepr(v.v)} to int loses precision`);
    return floatToInt(v.v);
  }
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPArray || v instanceof PHPObject) argTypeErr('int', v);
  if (typeof v === 'string') {
    const n = numericStr(v);
    if (n === null) { const m = NUM_LEAD.exec(v); if (!m) argTypeErr('int', v); }
    else if (n instanceof Flt) {
      if (!isFinite(n.v) || n.v >= 9223372036854775808 || n.v < -9223372036854775808) argTypeErr('int', v);
      if (!Number.isInteger(n.v)) deprecated(`Implicit conversion from float-string "${v}" to int loses precision`);
      return floatToInt(n.v);
    }
  }
  return toInt(v);
};
export const N = (v) => { // JS number from int|float param
  if (typeof v === 'number') return v;
  if (v instanceof Flt) return v.v;
  if (rt.nativeStrict) { if (v instanceof Ref) v = v.v; if (isNum(v)) return toDbl(v); argTypeErr('int|float', v); }
  if (v === null) { nullArgDeprecation('int|float'); return 0; }
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPArray || v instanceof PHPObject) argTypeErr('int|float', v);
  if (typeof v === 'string' && numericStr(v) === null && !NUM_LEAD.test(v)) argTypeErr('int|float', v);
  return toDbl(v);
};
export const A = (v) => {
  if (v instanceof PHPArray) return v;
  if (v instanceof Ref) v = v.v;
  if (!(v instanceof PHPArray)) argTypeErr('array', v);
  return v;
};
export const IntN = (v) => { if (isNum(v)) return v; if (rt.nativeStrict) argTypeErr('int|float', v instanceof Ref ? v.v : v); if (v === null) { nullArgDeprecation('int|float'); return 0; } if (v instanceof PHPArray || v instanceof PHPObject) argTypeErr('int|float', v); return toNumber(v); }; // keep int|float
export function deref(v) { return v instanceof Ref ? v.v : v; }
// copy an array slot into a new array: shared references stay references (like ZVAL_COPY)
export function slotCp(x) { if (x instanceof Ref) return x._weak ? cp(x.v) : x; return cp(x); }
export function refArr(ref) { return writableArrIn(ref); }
export const R1 = { refs: [true] };
