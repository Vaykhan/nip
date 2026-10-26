// Core value model.
//   null, true/false, int (JS number when safe, BigInt otherwise within int64),
//   float (Flt box), string (JS byte string), PHPArray, PHPObject, PHPResource,
//   plus references (Ref) and the control-flow signals used by the runtime.

import { floatToInt } from './convert.js';
import { rt } from './runtime/state.js';
import { deprecated, throwError, warn } from './runtime/errors.js';

export class Flt { constructor(v) { this.v = v; } }
export const mkf = (v) => new Flt(v);
export class Ref { constructor(v) { this.v = v === undefined ? null : v; } }

export const MAXS = Number.MAX_SAFE_INTEGER;
export const I64MAX = 9223372036854775807n, I64MIN = -9223372036854775808n;
const BMAXS = 9007199254740991n, BMINS = -9007199254740991n;

export function normBig(b) { return (b >= BMINS && b <= BMAXS) ? Number(b) : b; }
export function isInt(v) { return typeof v === 'number' || typeof v === 'bigint'; }
export function bigOrFloat(r, fallback) { return (r > I64MAX || r < I64MIN) ? mkf(fallback) : normBig(r); }

export function intAdd(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAXS && r >= -MAXS) return r; }
  return bigOrFloat(BigInt(a) + BigInt(b), Number(a) + Number(b));
}
export function intSub(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAXS && r >= -MAXS) return r; }
  return bigOrFloat(BigInt(a) - BigInt(b), Number(a) - Number(b));
}
export function intMul(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAXS && r >= -MAXS) return r === 0 ? 0 : r; }
  return bigOrFloat(BigInt(a) * BigInt(b), Number(a) * Number(b));
}

// ---------------------------------------------------------------- float format
export function fmtFloat(x, prec) {
  if (x !== x) return 'NAN';
  if (x === Infinity) return 'INF';
  if (x === -Infinity) return '-INF';
  if (x === 0) return (1 / x < 0) ? '-0' : '0';
  const neg = x < 0, ax = neg ? -x : x;
  const s = prec < 0 ? ax.toExponential() : ax.toExponential(Math.min(prec, 100) - 1);
  const ei = s.indexOf('e');
  let digits = s.slice(0, ei).replace('.', '').replace(/0+$/, '');
  if (!digits) digits = '0';
  const decpt = parseInt(s.slice(ei + 1), 10) + 1;
  const nd = prec < 0 ? 17 : prec;
  let out;
  if (decpt < 0 ? decpt < -3 : decpt > nd) {
    const e = decpt - 1;
    out = digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + 'E' + (e < 0 ? '-' : '+') + Math.abs(e);
  } else if (decpt <= 0) out = '0.' + '0'.repeat(-decpt) + digits;
  else if (digits.length <= decpt) out = digits + '0'.repeat(decpt - digits.length);
  else out = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  return neg ? '-' + out : out;
}
export const fmtRepr = (x) => fmtFloat(x, rt.serializePrecision);
export function fmtReprZ(x) { // with ".0" for integral finite values (var_export / json PRESERVE_ZERO_FRACTION)
  const s = fmtRepr(x);
  return (/^-?\d+$/.test(s)) ? s + '.0' : s;
}

// ---------------------------------------------------------------- numeric strings
export const NUM_FULL = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;
export const NUM_LEAD = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
export const INT_LIKE = /^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/;

export function numFromText(t) { // t matched NUM_LEAD (may have leading/trailing ws)
  t = t.trim();
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (n <= MAXS && n >= -MAXS) return n === 0 ? 0 : n;
    const b = BigInt(t);
    if (b > I64MAX || b < I64MIN) return mkf(n);
    return normBig(b);
  }
  return mkf(Number(t));
}
// returns number value or null if not a fully numeric string
export function numericStr(s) {
  if (s.length === 0 || s.length > 400) { if (s.length === 0) return null; }
  const c = s.charCodeAt(0);
  if (!((c >= 48 && c <= 57) || c === 32 || c === 43 || c === 45 || c === 46 || (c >= 9 && c <= 13))) return null;
  if (!NUM_FULL.test(s)) return null;
  return numFromText(s);
}

// ---------------------------------------------------------------- arrays
export class PHPArray {
  // Storage: parallel key/value arrays in insertion order. `map` (key -> index) is only built
  // once the array stops being a packed list (keys exactly 0..n-1 with no holes), like PHP's
  // packed hashtables.
  constructor() {
    this.k = []; this.v = []; this.map = null;
    this.nf = null;      // next free integer key (null = no int keys yet)
    this.holes = 0; this.cow = false; this.pos = 0; this.iters = 0; this.fe = 0;
    this.itList = null; // positions of by-reference foreach loops over this array (PHP's hash iterators)
  }
  // when entries move to new indexes without holes, iterator positions follow them
  _remapIters(shift = 0) {
    if (this.itList === null || this.itList.length === 0) return;
    for (const it of this.itList) {
      let live = 0;
      for (let i = 0; i < it.pos && i < this.k.length; i++) if (this.k[i] !== undefined) live++;
      it.pos = live + shift;
    }
  }
  get size() { return this.map === null ? this.k.length : this.map.size; }
  static from(list) { const a = new PHPArray(); const n = list.length; for (let i = 0; i < n; i++) { a.k.push(i); a.v.push(list[i]); } a.nf = n ? n : null; return a; }
  static fromMap(obj) { const a = new PHPArray(); for (const key of Object.keys(obj)) a.set(normKey(key), obj[key]); return a; }
  static fromPairs(pairs) { const a = new PHPArray(); for (const [k, v] of pairs) a.set(k, v); return a; }
  _unpack() {
    if (this.map !== null) return;
    const m = new Map(); const k = this.k;
    for (let i = 0; i < k.length; i++) m.set(i, i);
    this.map = m;
  }
  index(key) {
    if (this.map === null) return (typeof key === 'number' && key >= 0 && key < this.k.length) ? key : undefined;
    return this.map.get(key);
  }
  nextKey() { return this.nf === null ? 0 : this.nf; }
  has(key) { return this.index(key) !== undefined; }
  get(key) { const i = this.index(key); if (i === undefined) return undefined; const v = this.v[i]; return v instanceof Ref ? v.v : v; }
  getRaw(key) { const i = this.index(key); return i === undefined ? undefined : this.v[i]; }
  _noteKey(key) {
    if (typeof key === 'number') { if (this.nf === null || key >= this.nf) this.nf = key + 1; if (this.nf > MAXS) this.nf = BigInt(key) + 1n; }
    else if (typeof key === 'bigint') { if (this.nf === null || key >= this.nf) this.nf = normBig(key + 1n); }
  }
  _append(key, val) {
    const n = this.k.length;
    if (this.map === null) {
      if (key === n && (this.nf === null || this.nf === n)) { this.k.push(key); this.v.push(val); this.nf = n + 1; return; }
      this._unpack();
    }
    this.map.set(key, n); this.k.push(key); this.v.push(val);
    if (typeof key !== 'string') this._noteKey(key);
  }
  set(key, val) {
    const i = this.index(key);
    if (i !== undefined) { const cur = this.v[i]; if (cur instanceof Ref) cur.v = val; else this.v[i] = val; return; }
    this._append(key, val);
  }
  setRaw(key, val) { // replaces slot (used to install references)
    const i = this.index(key);
    if (i !== undefined) { this.v[i] = val; return; }
    this._append(key, val);
  }
  push(val) {
    const key = this.nextKey();
    if (typeof key === 'bigint' && key > I64MAX) throwError('Error', 'Cannot add element to the array as the next element is already occupied');
    if (this.map === null && key === this.k.length) { this.k.push(key); this.v.push(val); this.nf = key + 1; return true; }
    this._unpack();
    this.map.set(key, this.k.length); this.k.push(key); this.v.push(val);
    this.nf = typeof key === 'number' ? (key + 1 > MAXS ? BigInt(key) + 1n : key + 1) : normBig(key + 1n);
    return true;
  }
  popLast() { // array_pop on a packed list keeps it packed
    if (this.map === null) { const v = this.v.pop(); this.k.pop(); this.nf = this.k.length || null; if (this.pos > this.k.length) this.pos = this.k.length; return v instanceof Ref ? v.v : v; }
    const k = this.lastKey(); const v = this.get(k); this.delete(k);
    this.nf = null; for (const kk of this.k) if (kk !== undefined && typeof kk !== 'string') this._noteKey(kk);
    return v;
  }
  delete(key) {
    const i = this.index(key);
    if (i === undefined) return;
    this._unpack();
    this.map.delete(key);
    this.k[i] = undefined; this.v[i] = undefined; this.holes++;
    if (i === this.k.length - 1) {
      while (this.k.length && this.k[this.k.length - 1] === undefined) { this.k.pop(); this.v.pop(); this.holes--; }
    } else if (this.holes > 32 && this.holes * 2 > this.k.length && this.iters === 0) this.compact();
  }
  compact() {
    if (!this.holes) return;
    this._remapIters();
    const k = [], v = [], map = new Map(); let newPos = -1;
    for (let i = 0; i < this.k.length; i++) {
      if (i === this.pos) newPos = k.length;
      const key = this.k[i]; if (key === undefined) continue;
      map.set(key, k.length); k.push(key); v.push(this.v[i]);
    }
    if (newPos < 0) newPos = k.length;
    this.k = k; this.v = v; this.map = map; this.holes = 0; this.pos = newPos;
  }
  // take over another array's contents (functions that rebuild an array in place)
  replaceWith(o, shiftIters = 0) {
    this._remapIters(shiftIters);
    this.k = o.k; this.v = o.v; this.map = o.map; this.nf = o.nf; this.holes = o.holes; this.pos = o.pos;
  }
  clone() {
    const b = new PHPArray();
    if (this.holes) this.compact();
    b.k = this.k.slice(); b.v = this.v.slice(); b.map = this.map === null ? null : new Map(this.map);
    b.nf = this.nf; b.pos = this.pos;
    const vs = b.v;
    for (let i = 0; i < vs.length; i++) { const x = vs[i]; if (x instanceof PHPArray) x.cow = true; else if (x instanceof Ref && x._weak) vs[i] = cp(x.v); }
    return b;
  }
  keys() { const r = []; for (let i = 0; i < this.k.length; i++) if (this.k[i] !== undefined) r.push(this.k[i]); return r; }
  values() { const r = []; for (let i = 0; i < this.k.length; i++) if (this.k[i] !== undefined) { const v = this.v[i]; r.push(v instanceof Ref ? v.v : v); } return r; }
  entries() { const r = []; for (let i = 0; i < this.k.length; i++) if (this.k[i] !== undefined) { const v = this.v[i]; r.push([this.k[i], v instanceof Ref ? v.v : v]); } return r; }
  rawEntries() { const r = []; for (let i = 0; i < this.k.length; i++) if (this.k[i] !== undefined) r.push([this.k[i], this.v[i]]); return r; }
  firstKey() { for (let i = 0; i < this.k.length; i++) if (this.k[i] !== undefined) return this.k[i]; return null; }
  lastKey() { for (let i = this.k.length - 1; i >= 0; i--) if (this.k[i] !== undefined) return this.k[i]; return null; }
  isList() { if (this.map === null) return true; let n = 0; for (let i = 0; i < this.k.length; i++) { const key = this.k[i]; if (key === undefined) continue; if (key !== n) return false; n++; } return true; }
  // internal pointer helpers
  _skip() { while (this.pos < this.k.length && this.k[this.pos] === undefined) this.pos++; }
  curKey() { this._skip(); return this.pos < this.k.length ? this.k[this.pos] : null; }
  curVal() { this._skip(); if (this.pos >= this.k.length) return false; const v = this.v[this.pos]; return v instanceof Ref ? v.v : v; }
  reindex() { // renumber integer keys 0..n-1 keeping string keys
    this._remapIters();
    const ent = this.rawEntries(); this.k = []; this.v = []; this.map = null; this.nf = null; this.holes = 0; this.pos = 0;
    for (const [k, v] of ent) { if (typeof k === 'string') this.setRaw(k, v); else this.push(v); }
  }
}

// ctx: KEY_ISSET (isset/empty/??) or KEY_UNSET for the wording of the illegal offset error
export const KEY_ISSET = 1, KEY_UNSET = 2;
function illegalOffset(k, ctx) {
  const t = k instanceof PHPObject ? k.cls.name : 'array';
  if (ctx === KEY_ISSET) throwError('TypeError', `Cannot access offset of type ${t} in isset or empty`);
  throwError('TypeError', `Cannot ${ctx === KEY_UNSET ? 'unset' : 'access'} offset of type ${t} on array`);
}
export function normKey(k, ctx) {
  switch (typeof k) {
    case 'number': return k;
    case 'string': {
      const n = k.length;
      if (n === 0 || n > 20) return k;
      const c = k.charCodeAt(0);
      if (!((c >= 48 && c <= 57) || c === 45)) return k;
      if (!/^(?:0|-?[1-9][0-9]*)$/.test(k)) return k;
      if (n < 16) return Number(k);
      const b = BigInt(k);
      if (b > I64MAX || b < I64MIN) return k;
      return normBig(b);
    }
    case 'bigint': return k;
    case 'boolean': return k ? 1 : 0;
    case 'object':
      if (k === null) return '';
      if (k instanceof Flt) {
        const x = k.v;
        if (!isFinite(x)) return 0;
        const t = Math.trunc(x);
        if (t !== x) deprecated(`Implicit conversion from float ${fmtRepr(x)} to int loses precision`);
        return floatToInt(t);
      }
      if (k instanceof PHPResource) { warn(`Resource ID#${k.id} used as offset, casting to integer (${k.id})`); return k.id; }
      if (k instanceof PHPArray || k instanceof PHPObject) illegalOffset(k, ctx);
  }
  return k;
}

// copy semantics for storing a value somewhere
export function cp(v) { if (v instanceof PHPArray) v.cow = true; return v; }

// ---------------------------------------------------------------- objects
// Object handles: freed handles are reused, most recently freed first (see runtime/gc.js)
// recent: inside try blocks, the objects created there (see Try in compiler/stmt.js)
export const objHandles = { next: 0, free: [], allocs: 0, recent: null };
export class PHPObject {
  constructor(cls) {
    this.cls = cls; this.props = new Map();
    objHandles.allocs++;
    if (objHandles.recent !== null && objHandles.recent.length < 64) objHandles.recent.push(this);
    this.id = objHandles.free.length ? objHandles.free.pop() : ++objHandles.next;
  }
}
export class PHPResource {
  constructor(type, h) { this.type = type; this.h = h; this.id = ++PHPResource.n; this.closed = false; }
}
PHPResource.n = 3;

// ---------------------------------------------------------------- control signals
export class ThrowSig { constructor(obj) { this.obj = obj; } }
export class ExitSig { constructor(code) { this.code = code; } }
export class FatalSig { constructor(msg, line, file, kind) { this.msg = msg; this.line = line; this.file = file; this.kind = kind; } }
export class ParseErr { constructor(msg, line, kind) { this.msg = msg; this.line = line; this.kind = kind; } }
export const NOREF = new Ref(undefined);
