// Array functions and sorting.

import { cp, Flt, isInt, mkf, normKey, numericStr, PHPArray, PHPObject, Ref } from '../values.js';
import { toBool, toDbl, toInt, toNumber, toStr, typeOf } from '../convert.js';
import { cmp, looseEq, numCmp, strCmp, strictEq } from '../compare.js';
import { add, mul } from '../arith.js';
import { iterateObject } from '../compiler/stmt.js';
import { rt } from '../runtime/state.js';
import { throwError, warn } from '../runtime/errors.js';
import { callableFn, callValue, findMethod } from '../runtime/callables.js';
import { callMethodName, magicGet, magicIsset, objVisibleProps, writeProp } from '../runtime/classes.js';
import { A, alias, def, deref, I, R1, refArr, slotCp } from './core.js';
import { lower, natCmp, sgn, upper } from './string.js';
import { mtRange } from './math.js';

function sortComparator(flags) {
  const f = I(flags);
  const ci = (f & 8) !== 0;
  switch (f & ~8) {
    case 1: return (a, b) => numCmp(toNumber(a), toNumber(b));
    case 2: case 5: return ci ? (a, b) => strCmp(lower(toStr(a)), lower(toStr(b))) : (a, b) => strCmp(toStr(a), toStr(b));
    case 6: return (a, b) => natCmp(toStr(a), toStr(b), ci);
    default: return cmp;
  }
}
function userCmp(cb) {
  const fn = callableFn(cb);
  return (a, b) => {
    const r = fn(a, b);
    if (typeof r === 'boolean') {
      if (r) return 1;
      return toBool(fn(b, a)) ? -1 : 0;
    }
    const n = toNumber(r);
    return n instanceof Flt ? sgn(n.v) : sgn(Number(n));
  };
}
function sortValues(ref, c, rev) {
  const a = A(deref(ref));
  const vals = a.values();
  vals.sort(rev ? (x, y) => c(y, x) : c);
  ref.v = PHPArray.from(vals);
  return true;
}
function sortEntries(ref, c, byKey, rev) {
  const a = A(deref(ref));
  const ent = a.rawEntries();
  ent.sort(byKey ? (x, y) => (rev ? c(y[0], x[0]) : c(x[0], y[0])) : (x, y) => (rev ? c(deref(y[1]), deref(x[1])) : c(deref(x[1]), deref(y[1]))));
  const out = new PHPArray();
  for (const [k, v] of ent) out.setRaw(k, v);
  ref.v = out;
  return true;
}
def('sort', (array, flags = 0) => sortValues(array, sortComparator(flags), false), R1);
def('rsort', (array, flags = 0) => sortValues(array, sortComparator(flags), true), R1);
def('usort', (array, callback) => sortValues(array, userCmp(callback), false), R1);
def('asort', (array, flags = 0) => sortEntries(array, sortComparator(flags), false, false), R1);
def('arsort', (array, flags = 0) => sortEntries(array, sortComparator(flags), false, true), R1);
def('uasort', (array, callback) => sortEntries(array, userCmp(callback), false, false), R1);
def('ksort', (array, flags = 0) => sortEntries(array, sortComparator(flags), true, false), R1);
def('krsort', (array, flags = 0) => sortEntries(array, sortComparator(flags), true, true), R1);
def('uksort', (array, callback) => sortEntries(array, userCmp(callback), true, false), R1);
def('natsort', (array) => sortEntries(array, (a, b) => natCmp(toStr(a), toStr(b), false), false, false), R1);
def('natcasesort', (array) => sortEntries(array, (a, b) => natCmp(toStr(a), toStr(b), true), false, false), R1);
def('shuffle', (array) => {
  const vals = A(deref(array)).values();
  for (let i = vals.length - 1; i > 0; i--) { const j = mtRange(0, i); [vals[i], vals[j]] = [vals[j], vals[i]]; }
  array.v = PHPArray.from(vals); return true;
}, R1);
def('array_multisort', (array, ...rest) => {
  const a = A(deref(array));
  const vals = a.values();
  const idx = vals.map((_, i) => i);
  let order = 4; // SORT_ASC
  for (const r of rest) { const v = deref(r); if (isInt(v) && (v === 3)) order = 3; }
  idx.sort((x, y) => { const c = cmp(vals[x], vals[y]); return order === 3 ? -c : c; });
  array.v = PHPArray.from(idx.map((i) => vals[i]));
  for (const r of rest) if (r instanceof Ref && r.v instanceof PHPArray && r.v.size === vals.length) { const ov = r.v.values(); r.v = PHPArray.from(idx.map((i) => ov[i])); }
  return true;
}, { refs: [true], refRest: 1 });

def('count', (value, mode = 0) => {
  if (value instanceof PHPArray) {
    if (I(mode) === 1) {
      let n = 0; const seen = new Set();
      const walk = (a) => { if (seen.has(a)) { warn('count(): Recursion detected'); return; } seen.add(a); for (const v of a.values()) { n++; if (v instanceof PHPArray) walk(v); } seen.delete(a); };
      walk(value); return n;
    }
    return value.size;
  }
  if (value instanceof PHPObject && value.cls.ancestors.has('countable')) return toInt(callMethodName(value, 'count', []));
  throwError('TypeError', `count(): Argument #1 ($value) must be of type Countable|array, ${typeOf(value)} given`);
});
alias('sizeof', 'count');
def('array_keys', (array, filter_value = undefined, strict = false) => {
  const a = A(array);
  if (filter_value === undefined) return PHPArray.from(a.keys());
  const st = toBool(strict);
  return PHPArray.from(a.entries().filter(([, v]) => (st ? strictEq(v, filter_value) : looseEq(v, filter_value))).map(([k]) => k));
});
def('array_values', (array) => PHPArray.from(A(array).rawEntries().map(([, x]) => slotCp(x))));
def('array_merge', (...arrays) => {
  const out = new PHPArray();
  for (const a0 of arrays) {
    const a = A(a0);
    for (const [k, v] of a.rawEntries()) { if (typeof k === 'string') out.setRaw(k, slotCp(v)); else out.push(slotCp(v)); }
  }
  return out;
});
function mergeRecursive(dst, src) {
  for (const [k, v] of src.entries()) {
    if (typeof k === 'string' && dst.has(k)) {
      let cur = dst.get(k);
      let arr = cur instanceof PHPArray ? cur.clone() : PHPArray.from([cur]);
      if (v instanceof PHPArray) mergeRecursive(arr, v); else arr.push(cp(v));
      dst.set(k, arr);
    } else if (typeof k === 'string') dst.set(k, cp(v));
    else dst.push(cp(v));
  }
}
def('array_merge_recursive', (...arrays) => { const out = new PHPArray(); for (const a of arrays) mergeRecursive(out, A(a)); return out; });
def('array_replace', (array, ...replacements) => { const out = A(array).clone(); for (const r of replacements) for (const [k, v] of A(r).entries()) out.set(k, cp(v)); return out; });
function replaceRecursive(dst, src) {
  for (const [k, v] of src.entries()) {
    const cur = dst.get(k);
    if (v instanceof PHPArray && cur instanceof PHPArray) { const c = cur.clone(); replaceRecursive(c, v); dst.set(k, c); }
    else dst.set(k, cp(v));
  }
}
def('array_replace_recursive', (array, ...replacements) => { const out = A(array).clone(); for (const r of replacements) replaceRecursive(out, A(r)); return out; });
def('array_combine', (keys, values) => {
  const k = A(keys).values(), v = A(values).values();
  if (k.length !== v.length) throwError('ValueError', 'array_combine(): Argument #1 ($keys) and argument #2 ($values) must have the same number of elements');
  const out = new PHPArray(); for (let i = 0; i < k.length; i++) out.set(normKey(toKeyVal(k[i])), cp(v[i]));
  return out;
});
function toKeyVal(k) { return k instanceof PHPObject || k instanceof PHPArray ? toStr(k) : k; }
def('array_flip', (array) => {
  const out = new PHPArray();
  for (const [k, v] of A(array).entries()) {
    if (typeof v === 'string' || isInt(v)) out.set(normKey(v), k);
    else warn('array_flip(): Can only flip string and integer values, entry skipped');
  }
  return out;
});
def('array_slice', (array, offset, length = null, preserve_keys = false) => {
  const a = A(array); const ent = a.rawEntries(); const n = ent.length;
  let off = Number(I(offset)); if (off < 0) off = Math.max(0, n + off); if (off > n) off = n;
  const len = length === null ? null : Number(I(length));
  let end = len === null ? n : len < 0 ? n + len : off + len;
  if (end > n) end = n;
  const out = new PHPArray(); const pk = toBool(preserve_keys);
  for (let i = off; i < end; i++) { const [k, v] = ent[i]; if (typeof k === 'string' || pk) out.setRaw(k, slotCp(v)); else out.push(slotCp(v)); }
  return out;
});
def('array_splice', (array, offset, length = null, replacement = null) => {
  const a = A(deref(array)); const ent = a.rawEntries(); const n = ent.length;
  let off = Number(I(offset)); if (off < 0) off = Math.max(0, n + off); if (off > n) off = n;
  let len = length === null ? n - off : Number(I(length));
  let end = len < 0 ? Math.max(off, n + len) : Math.min(n, off + len);
  const removed = new PHPArray();
  for (let i = off; i < end; i++) { const [k, v] = ent[i]; if (typeof k === 'string') removed.set(k, deref(v)); else removed.push(deref(v)); }
  const rep = replacement === null ? [] : replacement instanceof PHPArray ? replacement.values() : [replacement];
  const out = new PHPArray();
  const add = ([k, v]) => { if (typeof k === 'string') out.setRaw(k, v); else out.push(v); };
  for (let i = 0; i < off; i++) add(ent[i]);
  for (const v of rep) out.push(cp(v));
  for (let i = end; i < n; i++) add(ent[i]);
  array.v = out;
  return removed;
}, R1);
def('array_map', (callback, array, ...arrays) => {
  if (arrays.length === 0) {
    const a = A(array);
    if (callback === null) return a.clone();
    const fn = callableFn(callback);
    const out = new PHPArray();
    const ks = a.k, vs = a.v;
    for (let i = 0; i < ks.length; i++) { const k = ks[i]; if (k === undefined) continue; const v = vs[i]; out.set(k, cp(fn(v instanceof Ref ? v.v : v))); }
    if (a.isList()) out.nf = a.nf;
    return out;
  }
  const lists = [A(array), ...arrays.map(A)].map((x) => x.values());
  const n = Math.max(...lists.map((l) => l.length));
  const out = new PHPArray();
  const fn = callback === null ? null : callableFn(callback);
  for (let i = 0; i < n; i++) {
    const args = lists.map((l) => (i < l.length ? l[i] : null));
    out.push(fn ? cp(fn(...args)) : PHPArray.from(args));
  }
  return out;
});
def('array_filter', (array, callback = null, mode = 0) => {
  const a = A(array); const out = new PHPArray(); const m = I(mode);
  const fn = callback === null ? null : callableFn(callback);
  for (const [k, v] of a.entries()) {
    let keep;
    if (!fn) keep = toBool(v);
    else if (m === 2) keep = toBool(fn(k));
    else if (m === 1) keep = toBool(fn(v, k));
    else keep = toBool(fn(v));
    if (keep) out.set(k, cp(v));
  }
  return out;
});
def('array_reduce', (array, callback, initial = null) => { const fn = callableFn(callback); let acc = initial; for (const v of A(array).values()) acc = fn(acc, v); return acc; });
function weakRefSlot(arr, i) { let s = arr.v[i]; if (!(s instanceof Ref)) { s = new Ref(s); s._weak = true; arr.v[i] = s; } return s; }
def('array_walk', (array, callback, arg = undefined) => {
  const target = deref(array);
  if (target instanceof PHPObject) { for (const [k, v] of objVisibleProps(target, rt.frame ? rt.frame.cls : null)) { const r = new Ref(v); callValue(callback, arg === undefined ? [r, k] : [r, k, arg]); writeProp(target, k, r.v, rt.frame); } return true; }
  const a = refArr(array);
  const fn = callableFn(callback);
  a.iters++;
  try {
    for (let i = 0; i < a.k.length; i++) {
      const k = a.k[i]; if (k === undefined) continue;
      const r = weakRefSlot(a, i);
      if (arg === undefined) fn(r, k); else fn(r, k, arg);
    }
  } finally { a.iters--; }
  return true;
}, R1);
def('array_walk_recursive', (array, callback, arg = undefined) => {
  const fn = callableFn(callback);
  const seen = new Set();
  const walk = (ref) => {
    const a = refArr(ref);
    if (a instanceof PHPObject) {
      for (const [k, v] of objVisibleProps(a, rt.frame ? rt.frame.cls : null)) { const r = new Ref(v); if (arg === undefined) fn(r, k); else fn(r, k, arg); }
      return;
    }
    if (seen.has(a)) { warn('array_walk_recursive(): Recursion detected'); return; }
    seen.add(a);
    for (let i = 0; i < a.k.length; i++) {
      const k = a.k[i]; if (k === undefined) continue;
      const r = weakRefSlot(a, i);
      if (r.v instanceof PHPArray) walk(r); else if (arg === undefined) fn(r, k); else fn(r, k, arg);
    }
    seen.delete(a);
  };
  walk(array);
  return true;
}, R1);
def('array_search', (needle, haystack, strict = false) => {
  const st = toBool(strict);
  for (const [k, v] of A(haystack).entries()) if (st ? strictEq(v, needle) : looseEq(v, needle)) return k;
  return false;
});
def('in_array', (needle, haystack, strict = false) => {
  const a = A(haystack); const st = toBool(strict);
  const vs = a.v, ks = a.k;
  if (st) { for (let i = 0; i < vs.length; i++) { if (ks[i] === undefined) continue; let v = vs[i]; if (v instanceof Ref) v = v.v; if (v === needle || strictEq(v, needle)) return true; } return false; }
  for (let i = 0; i < vs.length; i++) { if (ks[i] === undefined) continue; let v = vs[i]; if (v instanceof Ref) v = v.v; if (looseEq(v, needle)) return true; }
  return false;
});
def('array_key_exists', (key, array) => {
  if (array instanceof PHPObject) return array.props.has(toStr(key));
  return A(array).has(normKey(key === null ? '' : key));
});
alias('key_exists', 'array_key_exists');
def('array_key_first', (array) => A(array).firstKey());
def('array_key_last', (array) => A(array).lastKey());
def('array_push', (array, ...values) => { const a = refArr(array); for (const v of values) a.push(cp(v)); return a.size; }, R1);
def('array_pop', (array) => {
  const a0 = deref(array); if (!(a0 instanceof PHPArray)) A(a0);
  if (!a0.size) return null;
  const a = refArr(array);
  const v = a.popLast();
  a.pos = 0;
  return v;
}, R1);
def('array_shift', (array) => {
  const a0 = deref(array); if (!(a0 instanceof PHPArray)) A(a0);
  if (!a0.size) return null;
  const a = refArr(array);
  const k = a.firstKey(); const v = a.get(k); a.delete(k);
  a.reindex();
  return v;
}, R1);
def('array_unshift', (array, ...values) => {
  A(deref(array));
  const a = refArr(array);
  const out = new PHPArray();
  for (const v of values) out.push(v === a ? a.clone() : cp(v)); // unshifting the array onto itself adds its old contents
  for (const [k, v] of a.rawEntries()) { if (typeof k === 'string') out.setRaw(k, v); else out.push(v); }
  a.replaceWith(out, values.length);
  a.pos = 0;
  return a.size;
}, R1);
def('array_reverse', (array, preserve_keys = false) => {
  const ent = A(array).entries().reverse(); const out = new PHPArray(); const pk = toBool(preserve_keys);
  for (const [k, v] of ent) { if (typeof k === 'string' || pk) out.set(k, cp(v)); else out.push(cp(v)); }
  return out;
});
def('array_sum', (array) => { let s = 0; for (const v of A(array).values()) { if (v instanceof PHPArray || v instanceof PHPObject) { warn(`array_sum(): Addition is not supported on type ${typeOf(v)}`); continue; } s = add(s, toNumber(v)); } return s; });
def('array_product', (array) => { let s = 1; for (const v of A(array).values()) { if (v instanceof PHPArray || v instanceof PHPObject) { warn(`array_product(): Multiplication is not supported on type ${typeOf(v)}`); continue; } s = mul(s, toNumber(v)); } return s; });
def('array_unique', (array, flags = 2) => {
  const a = A(array); const out = new PHPArray(); const f = I(flags);
  if (f === 2 || f === 5) {
    const seen = new Set();
    for (const [k, v] of a.entries()) { const s = toStr(v); if (!seen.has(s)) { seen.add(s); out.set(k, cp(v)); } }
    return out;
  }
  const c = sortComparator(f);
  const kept = [];
  for (const [k, v] of a.entries()) { if (!kept.some((x) => c(x, v) === 0)) { kept.push(v); out.set(k, cp(v)); } }
  return out;
});
def('array_count_values', (array) => {
  const out = new PHPArray();
  for (const v of A(array).values()) {
    if (typeof v !== 'string' && !isInt(v)) { warn('array_count_values(): Can only count string and integer values, entry skipped'); continue; }
    const k = normKey(v); out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
});
def('array_fill', (start_index, count, value) => {
  const out = new PHPArray(); let k = I(start_index); const n = I(count);
  if (n < 0) throwError('ValueError', 'array_fill(): Argument #2 ($count) must be greater than or equal to 0');
  for (let i = 0; i < n; i++) { if (i === 0) out.set(k, cp(value)); else out.push(cp(value)); }
  return out;
});
def('array_fill_keys', (keys, value) => { const out = new PHPArray(); for (const k of A(keys).values()) out.set(normKey(toKeyVal(k)), cp(value)); return out; });
def('array_pad', (array, length, value) => {
  const a = A(array); const n = I(length); const sz = a.size;
  if (Math.abs(n) <= sz) return a.clone();
  const out = new PHPArray();
  if (n > 0) { for (const [k, v] of a.entries()) { if (typeof k === 'string') out.set(k, cp(v)); else out.push(cp(v)); } for (let i = sz; i < n; i++) out.push(cp(value)); }
  else { for (let i = sz; i < -n; i++) out.push(cp(value)); for (const [k, v] of a.entries()) { if (typeof k === 'string') out.set(k, cp(v)); else out.push(cp(v)); } }
  return out;
});
def('range', (start, end, step = 1) => {
  let st = step instanceof Flt ? step.v : toDbl(step);
  const isCharArg = (v) => typeof v === 'string' && v.length >= 1 && numericStr(v) === null;
  if (isCharArg(start) && isCharArg(end) && !(step instanceof Flt)) {
    let a = start.charCodeAt(0), b = end.charCodeAt(0); let s = Math.abs(toInt(step)) || 1;
    const out = [];
    if (a <= b) for (let c = a; c <= b; c += s) out.push(String.fromCharCode(c)); else for (let c = a; c >= b; c -= s) out.push(String.fromCharCode(c));
    return PHPArray.from(out);
  }
  const sv = typeof start === 'string' ? (start === '' ? 0 : toNumber(start)) : toNumber(start);
  const ev = typeof end === 'string' ? (end === '' ? 0 : toNumber(end)) : toNumber(end);
  const isF = sv instanceof Flt || ev instanceof Flt || (step instanceof Flt && !Number.isInteger(step.v)) || (typeof step === 'string' && toNumber(step) instanceof Flt);
  const a = toDbl(sv), b = toDbl(ev);
  st = Math.abs(st);
  if (st === 0) throwError('ValueError', 'range(): Argument #3 ($step) cannot be 0');
  if (Math.abs(b - a) < st && a !== b) { /* single element */ }
  const out = [];
  if (isF) {
    const n = Math.floor(Math.abs(b - a) / st + 1e-9);
    for (let i = 0; i <= n; i++) out.push(mkf(a <= b ? a + i * st : a - i * st));
  } else {
    const s = Math.round(st);
    if (a <= b) for (let x = a; x <= b; x += s) out.push(x); else for (let x = a; x >= b; x -= s) out.push(x);
    if (out.length > 1e8) throwError('ValueError', 'range(): too many elements');
  }
  return PHPArray.from(out);
});
def('array_column', (array, column_key, index_key = null) => {
  const out = new PHPArray();
  const get = (row, key) => {
    if (row instanceof PHPArray) { const k = normKey(key); return row.has(k) ? row.get(k) : undefined; }
    if (row instanceof PHPObject) { const k = toStr(key); return row.props.has(k) ? deref(row.props.get(k)) : (findMethod(row.cls, '__get') && toBool(magicIsset(row, k)) ? magicGet(row, k) : undefined); }
    return undefined;
  };
  for (const row of A(array).values()) {
    const v = column_key === null ? row : get(row, column_key);
    if (v === undefined) continue;
    if (index_key !== null) { const ik = get(row, index_key); if (ik !== undefined) { out.set(normKey(toKeyVal(ik)), cp(v)); continue; } }
    out.push(cp(v));
  }
  return out;
});
def('array_chunk', (array, length, preserve_keys = false) => {
  const n = I(length); if (n < 1) throwError('ValueError', 'array_chunk(): Argument #2 ($length) must be greater than 0');
  const out = new PHPArray(); let cur = null; const pk = toBool(preserve_keys);
  for (const [k, v] of A(array).entries()) {
    if (!cur || cur.size >= n) { cur = new PHPArray(); out.push(cur); }
    if (pk) cur.set(k, cp(v)); else cur.push(cp(v));
  }
  return out;
});
function setOp(arrays, keep, useKey, useVal, kcmp, vcmp) {
  const [first, ...others] = arrays.map(A);
  const out = new PHPArray();
  const otherSets = others.map((o) => (useVal && !useKey && !vcmp ? new Set(o.values().map(toStr)) : null));
  for (const [k, raw] of first.rawEntries()) {
    const v = deref(raw);
    let inAll = true, inAny = false;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      let found;
      if (useKey && useVal && kcmp) found = o.entries().some(([ok, ov]) => kcmp(k, ok) === 0 && (vcmp ? vcmp(v, ov) === 0 : toStr(ov) === toStr(v)));
      else if (useKey && useVal) found = o.has(k) && (vcmp ? vcmp(v, o.get(k)) === 0 : toStr(o.get(k)) === toStr(v));
      else if (useKey) found = kcmp ? o.keys().some((ok) => kcmp(k, ok) === 0) : o.has(k);
      else found = vcmp ? o.values().some((ov) => vcmp(v, ov) === 0) : otherSets[i].has(toStr(v));
      if (found) inAny = true; else inAll = false;
    }
    if (keep === 'diff' ? !inAny : inAll) out.setRaw(k, slotCp(raw));
  }
  return out;
}
const splitCb = (args) => { const cb = args[args.length - 1]; return [args.slice(0, -1), cb]; };
def('array_diff', (array, ...arrays) => setOp([array, ...arrays], 'diff', false, true));
def('array_diff_key', (array, ...arrays) => setOp([array, ...arrays], 'diff', true, false));
def('array_diff_assoc', (array, ...arrays) => setOp([array, ...arrays], 'diff', true, true));
def('array_udiff', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'diff', false, true, null, userCmp(cb)); });
def('array_diff_ukey', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'diff', true, false, userCmp(cb)); });
def('array_udiff_assoc', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'diff', true, true, null, userCmp(cb)); });
def('array_diff_uassoc', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'diff', true, true, userCmp(cb)); });
def('array_udiff_uassoc', (array, ...rest) => { const kc = rest.pop(), vc = rest.pop(); return setOp([array, ...rest], 'diff', true, true, userCmp(kc), userCmp(vc)); });
def('array_intersect_uassoc', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'inter', true, true, userCmp(cb)); });
def('array_uintersect_uassoc', (array, ...rest) => { const kc = rest.pop(), vc = rest.pop(); return setOp([array, ...rest], 'inter', true, true, userCmp(kc), userCmp(vc)); });
def('array_intersect', (array, ...arrays) => setOp([array, ...arrays], 'inter', false, true));
def('array_intersect_key', (array, ...arrays) => setOp([array, ...arrays], 'inter', true, false));
def('array_intersect_assoc', (array, ...arrays) => setOp([array, ...arrays], 'inter', true, true));
def('array_uintersect', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'inter', false, true, null, userCmp(cb)); });
def('array_intersect_ukey', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'inter', true, false, userCmp(cb)); });
def('array_uintersect_assoc', (array, ...rest) => { const [arrs, cb] = splitCb(rest); return setOp([array, ...arrs], 'inter', true, true, null, userCmp(cb)); });
def('array_rand', (array, num = 1) => {
  const keys = A(array).keys(); const n = I(num);
  if (!keys.length) throwError('ValueError', 'array_rand(): Argument #1 ($array) cannot be empty');
  if (n < 1 || n > keys.length) throwError('ValueError', 'array_rand(): Argument #2 ($num) must be between 1 and the number of elements in argument #1 ($array)');
  if (n === 1) return keys[mtRange(0, keys.length - 1)];
  const idx = keys.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = mtRange(0, i); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return PHPArray.from(idx.slice(0, n).sort((a, b) => a - b).map((i) => keys[i]));
});
def('array_is_list', (array) => A(array).isList());
def('array_find', (array, callback) => { const fn = callableFn(callback); for (const [k, v] of A(array).entries()) if (toBool(fn(v, k))) return v; return null; });
def('array_find_key', (array, callback) => { const fn = callableFn(callback); for (const [k, v] of A(array).entries()) if (toBool(fn(v, k))) return k; return null; });
def('array_any', (array, callback) => { const fn = callableFn(callback); for (const [k, v] of A(array).entries()) if (toBool(fn(v, k))) return true; return false; });
def('array_all', (array, callback) => { const fn = callableFn(callback); for (const [k, v] of A(array).entries()) if (!toBool(fn(v, k))) return false; return true; });
def('array_flip_dummy', () => 0); rt.fns.delete('array_flip_dummy');
def('array_change_key_case', (array, _case = 0) => { const out = new PHPArray(); for (const [k, v] of A(array).entries()) out.set(typeof k === 'string' ? (I(_case) ? upper(k) : lower(k)) : k, cp(v)); return out; });
// internal pointer
def('current', (array) => { const a = deref(array); if (a instanceof PHPObject) return false; return A(a).curVal(); });
alias('pos', 'current');
def('key', (array) => { const a = deref(array); if (!(a instanceof PHPArray)) return null; return a.curKey(); });
def('next', (array) => { const a = deref(array); if (!(a instanceof PHPArray)) return false; a._skip(); if (a.pos < a.k.length) a.pos++; return a.curVal(); }, R1);
def('prev', (array) => {
  const a = deref(array); if (!(a instanceof PHPArray)) return false;
  a._skip();
  let p = a.pos - 1; while (p >= 0 && a.k[p] === undefined) p--;
  if (p < 0) { a.pos = a.k.length; return false; }
  a.pos = p; return a.curVal();
}, R1);
def('reset', (array) => { const a = deref(array); if (!(a instanceof PHPArray)) return false; a.pos = 0; return a.curVal(); }, R1);
def('end', (array) => {
  const a = deref(array); if (!(a instanceof PHPArray)) return false;
  let p = a.k.length - 1; while (p >= 0 && a.k[p] === undefined) p--;
  if (p < 0) { a.pos = 0; return false; }
  a.pos = p; return a.curVal();
}, R1);
def('each', (array) => { throwError('Error', 'Call to undefined function each()'); });
rt.fns.delete('each');
def('iterator_to_array', (iterator, preserve_keys = true) => {
  const out = new PHPArray(); const pk = toBool(preserve_keys);
  if (iterator instanceof PHPArray) { for (const [k, v] of iterator.entries()) { if (pk) out.set(k, cp(v)); else out.push(cp(v)); } return out; }
  iterateObject(iterator, (k, v) => { if (pk) out.set(normKey(toKeyVal(k)), cp(v)); else out.push(cp(v)); });
  return out;
});
def('iterator_count', (iterator) => { if (iterator instanceof PHPArray) return iterator.size; let n = 0; iterateObject(iterator, () => { n++; }); return n; });
def('iterator_apply', (iterator, callback, args = null) => { let n = 0; const a = args ? A(args).values() : []; iterateObject(iterator, () => { n++; return toBool(callValue(callback, a)); }); return n; });
