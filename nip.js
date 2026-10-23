#!/usr/bin/env node
/*
 * NIP (Nip is php) — a PHP 8.3 interpreter written in pure Node.js (no dependencies).
 *
 * Usage:
 *   node nip.js script.php [args...]
 *   node nip.js -r 'echo "hi\n";'
 *   echo '<?php echo 1;' | node nip.js
 *   node nip.js -l script.php        (syntax check)
 *
 * Embedding:
 *   const php = require('./nip.js');
 *   const { output, exitCode } = php.run('<?php echo "hi";', { capture: true });
 *
 * Architecture: lexer -> recursive-descent/Pratt parser -> AST -> closure compiler
 * (each AST node becomes a JS closure) -> execution. Generators are compiled to JS
 * generator functions. Strings are PHP byte strings (each JS char code is a byte 0-255).
 */
'use strict';

const fs = require('fs');
const pathMod = require('path');
const crypto = require('crypto');
const osMod = require('os');
const cpMod = require('child_process');

// CLI fast path: the main thread only spawns a worker thread with a large stack (so deep PHP
// recursion works) and returns without initializing the interpreter itself.
if (require.main === module) {
  try { require('module').enableCompileCache?.(); } catch (e) { /* optional */ }
  const wt = require('worker_threads');
  if (wt.isMainThread && !process.env.PHPJS_NO_WORKER) {
    let w = null;
    try {
      w = new wt.Worker(__filename, { argv: process.argv.slice(2), resourceLimits: { stackSizeMb: 256, maxOldGenerationSizeMb: 4096 }, stdout: false, stderr: false, stdin: false });
    } catch (e) { w = null; }
    if (w) {
      w.on('message', (m) => { if (m && m.exit !== undefined) process.exitCode = m.exit; });
      w.on('error', (e) => { process.stderr.write('PHP Fatal error:  ' + ((e && e.stack) || e) + '\n'); process.exitCode = 255; });
      w.on('exit', () => { process.exit(process.exitCode || 0); });
      return;
    }
    process.env.PHPJS_NO_WORKER = '1';
  }
}

// ============================================================================
// Core value model
//   null, true/false, int (JS number when safe, BigInt otherwise within int64),
//   float (Flt box), string (JS byte string), PHPArray, PHPObject, PHPResource
// ============================================================================

class Flt { constructor(v) { this.v = v; } }
const mkf = (v) => new Flt(v);
class Ref { constructor(v) { this.v = v === undefined ? null : v; } }

const MAXS = Number.MAX_SAFE_INTEGER;
const I64MAX = 9223372036854775807n, I64MIN = -9223372036854775808n;
const BMAXS = 9007199254740991n, BMINS = -9007199254740991n;

function normBig(b) { return (b >= BMINS && b <= BMAXS) ? Number(b) : b; }
function isInt(v) { return typeof v === 'number' || typeof v === 'bigint'; }
function bigOrFloat(r, fallback) { return (r > I64MAX || r < I64MIN) ? mkf(fallback) : normBig(r); }

function intAdd(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAXS && r >= -MAXS) return r; }
  return bigOrFloat(BigInt(a) + BigInt(b), Number(a) + Number(b));
}
function intSub(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAXS && r >= -MAXS) return r; }
  return bigOrFloat(BigInt(a) - BigInt(b), Number(a) - Number(b));
}
function intMul(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAXS && r >= -MAXS) return r === 0 ? 0 : r; }
  return bigOrFloat(BigInt(a) * BigInt(b), Number(a) * Number(b));
}

// ---------------------------------------------------------------- float format
function fmtFloat(x, prec) {
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
const fmtRepr = (x) => fmtFloat(x, rt.serializePrecision);
function fmtReprZ(x) { // with ".0" for integral finite values (var_export / json PRESERVE_ZERO_FRACTION)
  const s = fmtRepr(x);
  return (/^-?\d+$/.test(s)) ? s + '.0' : s;
}

// ---------------------------------------------------------------- numeric strings
const WS = ' \t\n\r\v\f';
const NUM_FULL = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/;
const NUM_LEAD = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const INT_LIKE = /^[ \t\n\r\v\f]*[+-]?\d+[ \t\n\r\v\f]*$/;

function numFromText(t) { // t matched NUM_LEAD (may have leading/trailing ws)
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
function numericStr(s) {
  if (s.length === 0 || s.length > 400) { if (s.length === 0) return null; }
  const c = s.charCodeAt(0);
  if (!((c >= 48 && c <= 57) || c === 32 || c === 43 || c === 45 || c === 46 || (c >= 9 && c <= 13))) return null;
  if (!NUM_FULL.test(s)) return null;
  return numFromText(s);
}
function isNumericStr(s) { return numericStr(s) !== null; }

// ---------------------------------------------------------------- arrays
class PHPArray {
  // Storage: parallel key/value arrays in insertion order. `map` (key -> index) is only built
  // once the array stops being a packed list (keys exactly 0..n-1 with no holes), like PHP's
  // packed hashtables.
  constructor() {
    this.k = []; this.v = []; this.map = null;
    this.nf = null;      // next free integer key (null = no int keys yet)
    this.holes = 0; this.cow = false; this.pos = 0; this.iters = 0; this.fe = 0;
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
    const k = [], v = [], map = new Map(); let newPos = -1;
    for (let i = 0; i < this.k.length; i++) {
      if (i === this.pos) newPos = k.length;
      const key = this.k[i]; if (key === undefined) continue;
      map.set(key, k.length); k.push(key); v.push(this.v[i]);
    }
    if (newPos < 0) newPos = k.length;
    this.k = k; this.v = v; this.map = map; this.holes = 0; this.pos = newPos;
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
    const ent = this.rawEntries(); this.k = []; this.v = []; this.map = null; this.nf = null; this.holes = 0; this.pos = 0;
    for (const [k, v] of ent) { if (typeof k === 'string') this.setRaw(k, v); else this.push(v); }
  }
}

function normKey(k) {
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
      if (k instanceof PHPArray) throwError('TypeError', 'Illegal offset type');
      if (k instanceof PHPObject) {
        if (k.cls.isEnum) throwError('TypeError', `Cannot access offset of type ${k.cls.name} on array`);
        throwError('TypeError', `Cannot access offset of type ${k.cls.name} on array`);
      }
  }
  return k;
}

// copy semantics for storing a value somewhere
function cp(v) { if (v instanceof PHPArray) v.cow = true; return v; }

// ---------------------------------------------------------------- objects
let objIdCounter = 0;
class PHPObject {
  constructor(cls) { this.cls = cls; this.props = new Map(); this.id = ++objIdCounter; }
}
class PHPResource {
  constructor(type, h) { this.type = type; this.h = h; this.id = ++PHPResource.n; this.closed = false; }
}
PHPResource.n = 3;

// ---------------------------------------------------------------- control signals
class ThrowSig { constructor(obj) { this.obj = obj; } }
class ExitSig { constructor(code) { this.code = code; } }
class FatalSig { constructor(msg, line, file, kind) { this.msg = msg; this.line = line; this.file = file; this.kind = kind; } }
class ParseErr { constructor(msg, line, kind) { this.msg = msg; this.line = line; this.kind = kind; } }

// ============================================================================
// Conversions
// ============================================================================
function typeOf(v) { // get_debug_type
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'boolean': return 'bool';
    case 'number': case 'bigint': return 'int';
    case 'string': return 'string';
  }
  if (v instanceof Flt) return 'float';
  if (v instanceof PHPArray) return 'array';
  if (v instanceof PHPObject) return v.cls.anon ? displayName(v.cls) : v.cls.name;
  if (v instanceof PHPResource) return 'resource (' + v.type + ')';
  if (v instanceof Ref) return typeOf(v.v);
  return 'mixed';
}
function gettype(v) {
  if (v === null || v === undefined) return 'NULL';
  switch (typeof v) {
    case 'boolean': return 'boolean';
    case 'number': case 'bigint': return 'integer';
    case 'string': return 'string';
  }
  if (v instanceof Flt) return 'double';
  if (v instanceof PHPArray) return 'array';
  if (v instanceof PHPObject) return 'object';
  if (v instanceof PHPResource) return v.closed ? 'resource (closed)' : 'resource';
  return 'unknown type';
}

function toBool(v) {
  switch (typeof v) {
    case 'boolean': return v;
    case 'number': return v !== 0;
    case 'bigint': return v !== 0n;
    case 'string': return v !== '' && v !== '0';
  }
  if (v === null || v === undefined) return false;
  if (v instanceof Flt) return v.v !== 0;
  if (v instanceof PHPArray) return v.size > 0;
  if (v instanceof PHPObject && v.cls.toBoolHook) return v.cls.toBoolHook(v);
  return true;
}

function floatToInt(x) {
  if (!isFinite(x)) return 0;
  x = Math.trunc(x);
  if (x <= MAXS && x >= -MAXS) return x === 0 ? 0 : x;
  if (x >= 9223372036854775808 || x < -9223372036854775808) {
    // PHP 8 on 64-bit: out-of-range is UB; modern PHP returns wrapped value. Emulate modular arithmetic.
    return normBig(BigInt.asIntN(64, BigInt(x)));
  }
  return normBig(BigInt(x));
}

function toInt(v) {
  switch (typeof v) {
    case 'number': case 'bigint': return v;
    case 'boolean': return v ? 1 : 0;
    case 'string': {
      const m = NUM_LEAD.exec(v);
      if (!m) return 0;
      const n = numFromText(m[0]);
      return n instanceof Flt ? floatToInt(n.v) : n;
    }
  }
  if (v === null || v === undefined) return 0;
  if (v instanceof Flt) return floatToInt(v.v);
  if (v instanceof PHPArray) return v.size ? 1 : 0;
  if (v instanceof PHPResource) return v.id;
  if (v instanceof PHPObject) { warn(`Object of class ${v.cls.name} could not be converted to int`); return 1; }
  return 0;
}
function toDbl(v) { // JS number
  switch (typeof v) {
    case 'number': return v;
    case 'bigint': return Number(v);
    case 'boolean': return v ? 1 : 0;
    case 'string': { const m = NUM_LEAD.exec(v); return m ? Number(m[0].trim()) : 0; }
  }
  if (v === null || v === undefined) return 0;
  if (v instanceof Flt) return v.v;
  if (v instanceof PHPArray) return v.size ? 1 : 0;
  if (v instanceof PHPResource) return v.id;
  if (v instanceof PHPObject) { warn(`Object of class ${v.cls.name} could not be converted to float`); return 1; }
  return 0;
}
// numeric value (int or Flt) for numeric contexts; does not warn
function toNumber(v) {
  switch (typeof v) {
    case 'number': case 'bigint': return v;
    case 'boolean': return v ? 1 : 0;
    case 'string': { const m = NUM_LEAD.exec(v); return m ? numFromText(m[0]) : 0; }
  }
  if (v === null || v === undefined) return 0;
  if (v instanceof Flt) return v;
  return toInt(v);
}

function toStr(v) {
  switch (typeof v) {
    case 'string': return v;
    case 'number': return v === 0 ? '0' : String(v);
    case 'bigint': return v.toString();
    case 'boolean': return v ? '1' : '';
  }
  if (v === null || v === undefined) return '';
  if (v instanceof Flt) return fmtFloat(v.v, rt.precision);
  if (v instanceof PHPArray) { warn('Array to string conversion'); return 'Array'; }
  if (v instanceof PHPObject) return objToString(v);
  if (v instanceof PHPResource) return 'Resource id #' + v.id;
  if (v instanceof Ref) return toStr(v.v);
  return String(v);
}
function objToString(o) {
  const m = findMethod(o.cls, '__tostring');
  if (m) { const r = callMethod(o, m, []); if (typeof r !== 'string') throwError('Error', `${o.cls.name}::__toString(): Return value must be of type string, ${typeOf(r)} returned`); return r; }
  throwError('Error', `Object of class ${o.cls.name} could not be converted to string`);
}

// ============================================================================
// Comparison
// ============================================================================
function numCmp(a, b) { // a, b are int or Flt
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if (!(a instanceof Flt) && !(b instanceof Flt)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  }
  const x = a instanceof Flt ? a.v : Number(a), y = b instanceof Flt ? b.v : Number(b);
  return x < y ? -1 : x > y ? 1 : x === y ? 0 : 1; // NaN: uncomparable
}
function numEq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (!(a instanceof Flt) && !(b instanceof Flt)) return BigInt(a) === BigInt(b);
  const x = a instanceof Flt ? a.v : Number(a), y = b instanceof Flt ? b.v : Number(b);
  return x === y;
}
function isNum(v) { return typeof v === 'number' || typeof v === 'bigint' || v instanceof Flt; }

function strCmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function looseEq(a, b) {
  if (a === b) return !(a instanceof Flt && a.v !== a.v);
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a === b;
  if (ta === 'string' && tb === 'string') {
    const na = numericStr(a); if (na === null) return false;
    const nb = numericStr(b); if (nb === null) return false;
    return numEq(na, nb);
  }
  if (ta === 'boolean' || tb === 'boolean') return toBool(a) === toBool(b);
  if (a === null || a === undefined) {
    if (b === null || b === undefined) return true;
    if (tb === 'string') return b === '';
    if (b instanceof PHPObject) return false;
    return !toBool(b);
  }
  if (b === null || b === undefined) return looseEq(b, a);
  if (isNum(a) && isNum(b)) return numEq(a, b);
  if (isNum(a) && tb === 'string') { const nb = numericStr(b); return nb !== null ? numEq(a, nb) : toStr(a) === b; }
  if (ta === 'string' && isNum(b)) return looseEq(b, a);
  if (a instanceof PHPArray && b instanceof PHPArray) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entries()) { if (!b.has(k)) return false; if (!looseEq(v, b.get(k))) return false; }
    return true;
  }
  if (a instanceof PHPObject && b instanceof PHPObject) {
    if (a === b) return true;
    if (a.cls !== b.cls) return false;
    if (a.cls.isEnum || a.cls === closureClass) return false;
    if (a.props.size !== b.props.size) return false;
    for (const [k, v] of a.props) { if (!b.props.has(k)) return false; const w = b.props.get(k); if (!looseEq(v instanceof Ref ? v.v : v, w instanceof Ref ? w.v : w)) return false; }
    return true;
  }
  if (a instanceof PHPObject) {
    if (tb === 'string' && findMethod(a.cls, '__tostring')) return toStr(a) === b;
    if (isNum(b)) { if (a.cls.isEnum) return false; return numEq(1, b); }
    return false;
  }
  if (b instanceof PHPObject) return looseEq(b, a);
  if (a instanceof PHPResource || b instanceof PHPResource) return toInt(a) === toInt(b) && (isNum(a) || isNum(b) || (a instanceof PHPResource && b instanceof PHPResource));
  return false;
}

function strictEq(a, b) {
  if (a === b) return !(a instanceof Flt && a.v !== a.v);
  const ta = typeof a;
  if (ta === 'number' || ta === 'bigint') return (typeof b === 'number' || typeof b === 'bigint') && BigInt(a) === BigInt(b);
  if (a instanceof Flt) return b instanceof Flt && a.v === b.v;
  if (a === undefined) return b === null;
  if (b === undefined) return a === null;
  if (a instanceof PHPArray && b instanceof PHPArray) {
    if (a.size !== b.size) return false;
    const ea = a.entries(), eb = b.entries();
    for (let i = 0; i < ea.length; i++) { if (ea[i][0] !== eb[i][0]) return false; if (!strictEq(ea[i][1], eb[i][1])) return false; }
    return true;
  }
  return false;
}

function cmp(a, b) { // <=> : -1 0 1
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'string' && tb === 'string') {
    const na = numericStr(a), nb = na === null ? null : numericStr(b);
    if (na !== null && nb !== null) return numCmp(na, nb);
    return strCmp(a, b);
  }
  if (ta === 'boolean' || tb === 'boolean' || a === null || b === null || a === undefined || b === undefined) {
    if ((a === null || a === undefined) && tb === 'string') return strCmp('', b);
    if ((b === null || b === undefined) && ta === 'string') return strCmp(a, '');
    if ((a === null || a === undefined) && b instanceof PHPObject) return -1;
    if ((b === null || b === undefined) && a instanceof PHPObject) return 1;
    const x = toBool(a), y = toBool(b);
    return x === y ? 0 : x ? 1 : -1;
  }
  if (isNum(a) && isNum(b)) return numCmp(a, b);
  if (isNum(a) && tb === 'string') { const nb = numericStr(b); return nb !== null ? numCmp(a, nb) : strCmp(toStr(a), b); }
  if (ta === 'string' && isNum(b)) { const na = numericStr(a); return na !== null ? numCmp(na, b) : strCmp(a, toStr(b)); }
  if (a instanceof PHPArray && b instanceof PHPArray) {
    if (a.size !== b.size) return a.size < b.size ? -1 : 1;
    for (const [k, v] of a.entries()) { if (!b.has(k)) return 1; const c = cmp(v, b.get(k)); if (c) return c; }
    return 0;
  }
  if (a instanceof PHPArray) return 1;
  if (b instanceof PHPArray) return -1;
  if (a instanceof PHPObject && b instanceof PHPObject) {
    if (a === b) return 0;
    if (a.cls !== b.cls) return 1;
    for (const [k, v] of a.props) { if (!b.props.has(k)) return 1; const w = b.props.get(k); const c = cmp(v instanceof Ref ? v.v : v, w instanceof Ref ? w.v : w); if (c) return c; }
    return 0;
  }
  if (a instanceof PHPObject) { if (tb === 'string' && findMethod(a.cls, '__tostring')) return strCmp(toStr(a), b); return 1; }
  if (b instanceof PHPObject) { if (ta === 'string' && findMethod(b.cls, '__tostring')) return strCmp(a, toStr(b)); return -1; }
  return numCmp(toNumber(a), toNumber(b));
}

// ============================================================================
// Arithmetic
// ============================================================================
function arithOperand(v, op, a, b) {
  switch (typeof v) {
    case 'number': case 'bigint': return v;
    case 'boolean': return v ? 1 : 0;
    case 'string': {
      const m = NUM_LEAD.exec(v);
      if (!m) throwError('TypeError', `Unsupported operand types: ${typeOf(a)} ${op} ${typeOf(b)}`);
      if (m[0].length !== v.length && !NUM_FULL.test(v)) warn('A non-numeric value encountered');
      return numFromText(m[0]);
    }
  }
  if (v === null || v === undefined) return 0;
  if (v instanceof Flt) return v;
  throwError('TypeError', `Unsupported operand types: ${typeOf(a)} ${op} ${typeOf(b)}`);
}

function add(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAXS && r >= -MAXS) return r; return intAdd(a, b); }
  if (a instanceof Flt && b instanceof Flt) return mkf(a.v + b.v);
  if (a instanceof PHPArray && b instanceof PHPArray) {
    const r = a.clone();
    for (const [k, v] of b.rawEntries()) if (!r.has(k)) r.setRaw(k, cp(v instanceof Ref ? v.v : v));
    return r;
  }
  const x = arithOperand(a, '+', a, b), y = arithOperand(b, '+', a, b);
  if (x instanceof Flt || y instanceof Flt) return mkf(toDbl(x) + toDbl(y));
  return intAdd(x, y);
}
function sub(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAXS && r >= -MAXS) return r; return intSub(a, b); }
  if (a instanceof Flt && b instanceof Flt) return mkf(a.v - b.v);
  const x = arithOperand(a, '-', a, b), y = arithOperand(b, '-', a, b);
  if (x instanceof Flt || y instanceof Flt) return mkf(toDbl(x) - toDbl(y));
  return intSub(x, y);
}
function mul(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAXS && r >= -MAXS) return r === 0 ? 0 : r; return intMul(a, b); }
  if (a instanceof Flt && b instanceof Flt) return mkf(a.v * b.v);
  const x = arithOperand(a, '*', a, b), y = arithOperand(b, '*', a, b);
  if (x instanceof Flt || y instanceof Flt) return mkf(toDbl(x) * toDbl(y));
  return intMul(x, y);
}
function div(a, b) {
  const x = arithOperand(a, '/', a, b), y = arithOperand(b, '/', a, b);
  if (y instanceof Flt ? y.v === 0 : (y === 0 || y === 0n)) throwError('DivisionByZeroError', 'Division by zero');
  if (!(x instanceof Flt) && !(y instanceof Flt)) {
    if (typeof x === 'number' && typeof y === 'number') { const r = x / y; if (Number.isInteger(r)) return r === 0 ? 0 : r; return mkf(r); }
    const bx = BigInt(x), by = BigInt(y);
    if (bx % by === 0n) return bigOrFloat(bx / by, Number(x) / Number(y));
    return mkf(Number(x) / Number(y));
  }
  return mkf(toDbl(x) / toDbl(y));
}
function mod(a, b) {
  const x = toIntOp(a, '%', a, b), y = toIntOp(b, '%', a, b);
  if (y === 0 || y === 0n) throwError('DivisionByZeroError', 'Modulo by zero');
  if (typeof x === 'number' && typeof y === 'number') { const r = x % y; return r === 0 ? 0 : r; }
  if ((y === -1 || y === -1n)) return 0;
  return normBig(BigInt(x) % BigInt(y));
}
function toIntOp(v, op, a, b) {
  const n = arithOperand(v, op, a, b);
  if (n instanceof Flt) {
    if (!isFinite(n.v) || Math.trunc(n.v) !== n.v || n.v >= 9223372036854775808 || n.v < -9223372036854775808) {
      if (typeof v === 'string') deprecated(`Implicit conversion from float-string "${v}" to int loses precision`);
      else deprecated(`Implicit conversion from float ${fmtRepr(n.v)} to int loses precision`);
    }
    return floatToInt(n.v);
  }
  return n;
}
function pow(a, b) {
  const x = arithOperand(a, '**', a, b), y = arithOperand(b, '**', a, b);
  if (!(x instanceof Flt) && !(y instanceof Flt) && Number(y) >= 0) {
    if (typeof x === 'number' && typeof y === 'number') { const r = Math.pow(x, y); if (r <= MAXS && r >= -MAXS) return r; }
    const by = BigInt(y);
    if (by > 4096n) { const r = Math.pow(Number(x), Number(y)); return mkf(r); }
    const r = BigInt(x) ** by;
    return bigOrFloat(r, Math.pow(Number(x), Number(y)));
  }
  return mkf(Math.pow(toDbl(x), toDbl(y)));
}
function neg(a) {
  if (typeof a === 'number') return a === 0 ? 0 : -a;
  if (a instanceof Flt) return mkf(-a.v);
  if (typeof a === 'bigint') return bigOrFloat(-a, -Number(a));
  return mul(a, -1);
}
function bitwiseOperand(v, op, a, b) {
  if (v instanceof PHPArray || v instanceof PHPObject) throwError('TypeError', `Unsupported operand types: ${typeOf(a)} ${op} ${typeOf(b)}`);
  return toIntOp(v, op, a, b);
}
function bitStr(a, b, f) {
  const n = f === 'and' || f === 'xor' ? Math.min(a.length, b.length) : Math.max(a.length, b.length);
  let r = '';
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i) || 0, y = b.charCodeAt(i) || 0;
    r += String.fromCharCode(f === 'and' ? x & y : f === 'or' ? x | y : x ^ y);
  }
  return r;
}
function bitAnd(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return bitStr(a, b, 'and');
  const x = bitwiseOperand(a, '&', a, b), y = bitwiseOperand(b, '&', a, b);
  if (typeof x === 'number' && typeof y === 'number' && x >= -2147483648 && x <= 2147483647 && y >= -2147483648 && y <= 2147483647) return x & y;
  return normBig(BigInt.asIntN(64, BigInt(x) & BigInt(y)));
}
function bitOr(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return bitStr(a, b, 'or');
  const x = bitwiseOperand(a, '|', a, b), y = bitwiseOperand(b, '|', a, b);
  if (typeof x === 'number' && typeof y === 'number' && x >= -2147483648 && x <= 2147483647 && y >= -2147483648 && y <= 2147483647) return x | y;
  return normBig(BigInt.asIntN(64, BigInt(x) | BigInt(y)));
}
function bitXor(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return bitStr(a, b, 'xor');
  const x = bitwiseOperand(a, '^', a, b), y = bitwiseOperand(b, '^', a, b);
  if (typeof x === 'number' && typeof y === 'number' && x >= -2147483648 && x <= 2147483647 && y >= -2147483648 && y <= 2147483647) return x ^ y;
  return normBig(BigInt.asIntN(64, BigInt(x) ^ BigInt(y)));
}
function bitNot(a) {
  if (typeof a === 'string') { let r = ''; for (let i = 0; i < a.length; i++) r += String.fromCharCode(~a.charCodeAt(i) & 255); return r; }
  if (a instanceof Flt) { if (!Number.isInteger(a.v) || a.v >= 9223372036854775808 || a.v < -9223372036854775808) deprecated(`Implicit conversion from float ${fmtRepr(a.v)} to int loses precision`); a = floatToInt(a.v); }
  else if (!isInt(a)) throwError('TypeError', `Cannot perform bitwise not on ${typeOf(a)}`);
  if (typeof a === 'number' && a >= -2147483648 && a <= 2147483647) return ~a;
  return normBig(BigInt.asIntN(64, ~BigInt(a)));
}
function shl(a, b) {
  const x = bitwiseOperand(a, '<<', a, b), y = bitwiseOperand(b, '<<', a, b);
  if (y < 0) throwError('ArithmeticError', 'Bit shift by negative number');
  if (y >= 64) return 0;
  if (typeof x === 'number' && y < 31 && x >= -1048576 && x <= 1048576 && y <= 10) return x << Number(y);
  return normBig(BigInt.asIntN(64, BigInt(x) << BigInt(y)));
}
function shr(a, b) {
  const x = bitwiseOperand(a, '>>', a, b), y = bitwiseOperand(b, '>>', a, b);
  if (y < 0) throwError('ArithmeticError', 'Bit shift by negative number');
  if (y >= 64) return x < 0 ? -1 : 0;
  if (typeof x === 'number' && x >= -2147483648 && x <= 2147483647) return x >> Number(y);
  return normBig(BigInt(x) >> BigInt(y));
}
function concat(a, b) {
  return (typeof a === 'string' ? a : toStr(a)) + (typeof b === 'string' ? b : toStr(b));
}

function strInc(s) {
  if (s === '') return '1';
  const n = numericStr(s);
  if (n !== null) return n instanceof Flt ? mkf(n.v + 1) : intAdd(n, 1);
  // perl-style increment
  if (!/^[a-zA-Z0-9]+$/.test(s)) deprecated('Increment on non-alphanumeric string is deprecated');
  const chars = s.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    const c = chars[i];
    if (c === 'z') { chars[i] = 'a'; i--; }
    else if (c === 'Z') { chars[i] = 'A'; i--; }
    else if (c === '9') { chars[i] = '0'; i--; }
    else if ((c >= 'a' && c < 'z') || (c >= 'A' && c < 'Z') || (c >= '0' && c < '9')) { chars[i] = String.fromCharCode(c.charCodeAt(0) + 1); return chars.join(''); }
    else return chars.join('');
  }
  const f = s[0];
  const pre = (f >= 'a' && f <= 'z') ? 'a' : (f >= 'A' && f <= 'Z') ? 'A' : '1';
  return pre + chars.join('');
}
function inc(v) {
  if (typeof v === 'number') return v < MAXS ? v + 1 : intAdd(v, 1);
  if (v === null || v === undefined) return 1;
  if (v instanceof Flt) return mkf(v.v + 1);
  if (typeof v === 'bigint') return intAdd(v, 1);
  if (typeof v === 'string') return strInc(v);
  if (typeof v === 'boolean') { warn('Increment on type bool has no effect, this will change in the next major version of PHP'); return v; }
  if (v instanceof PHPArray || v instanceof PHPObject) throwError('TypeError', `Cannot increment ${typeOf(v)}`);
  return v;
}
function dec(v) {
  if (typeof v === 'number') return v > -MAXS ? v - 1 : intSub(v, 1);
  if (v === null || v === undefined) { warn('Decrement on type null has no effect, this will change in the next major version of PHP'); return null; }
  if (v instanceof Flt) return mkf(v.v - 1);
  if (typeof v === 'bigint') return intSub(v, 1);
  if (typeof v === 'string') {
    if (v === '') { deprecated('Decrement on empty string is deprecated as non-numeric'); return -1; }
    const n = numericStr(v); if (n !== null) return n instanceof Flt ? mkf(n.v - 1) : intSub(n, 1);
    deprecated('Decrement on non-numeric string has no effect and is deprecated');
    return v;
  }
  if (typeof v === 'boolean') { warn('Decrement on type bool has no effect, this will change in the next major version of PHP'); return v; }
  if (v instanceof PHPArray || v instanceof PHPObject) throwError('TypeError', `Cannot decrement ${typeOf(v)}`);
  return v;
}

// ============================================================================
// Byte string <-> UTF-8 helpers
// ============================================================================
function utf8Decode(s) { // byte string -> JS unicode string
  let ascii = true;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) return s;
  return Buffer.from(s, 'latin1').toString('utf8');
}
function utf8Encode(s) { // JS unicode string -> byte string
  let ascii = true;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) return s;
  return Buffer.from(s, 'utf8').toString('latin1');
}
function isValidUtf8(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) {
    const b = Buffer.from(s, 'latin1');
    try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch (e) { return false; }
  }
  return true;
}
const bytes = (s) => Buffer.from(s, 'latin1');
const fromBytes = (b) => Buffer.from(b).toString('latin1');

// ============================================================================
// Lexer
// ============================================================================
const OPS3 = ['<<=', '>>=', '**=', '...', '<=>', '===', '!==', '??=', '?->'];
const OPS2 = ['++', '--', '->', '=>', '::', '==', '!=', '<>', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const OPS1 = '+-*/%=<>!.()[]{},;?:&|^~@$`\\';
const CAST_RE = /^\(\s*(int|integer|bool|boolean|float|double|real|string|binary|array|object|unset)\s*\)/i;
const isIdStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isIdChar = (c) => isIdStart(c) || (c >= 48 && c <= 57);

function encodeCodepoint(c) {
  if (c < 0x80) return String.fromCharCode(c);
  if (c < 0x800) return String.fromCharCode(0xC0 | (c >> 6), 0x80 | (c & 63));
  if (c < 0x10000) return String.fromCharCode(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  return String.fromCharCode(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
}
function lex(src, file) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const shortTags = typeof rt !== 'undefined' && rt.ini && /^(1|on|true)$/i.test(String(rt.ini.get('short_open_tag') || ''));
  const err = (m) => { throw new ParseErr(m, line); };
  const push = (t, v, extra) => { const tk = { t, v, l: line }; if (extra) Object.assign(tk, extra); toks.push(tk); return tk; };
  const countNl = (s) => { let c = 0; for (let j = 0; j < s.length; j++) if (s.charCodeAt(j) === 10) c++; return c; };

  function htmlMode() {
    let start = i;
    while (i < n) {
      const p = src.indexOf('<?', i);
      if (p < 0) { i = n; break; }
      if (src.substr(p, 5).toLowerCase() === '<?php' && (p + 5 >= n || /\s/.test(src[p + 5]))) {
        if (p > start) { const h = src.slice(start, p); push('html', h); line += countNl(h); }
        i = p + 5; if (src[i] === '\n') { line++; i++; } else if (src[i] === '\r' && src[i + 1] === '\n') { line++; i += 2; } else if (i < n) i++;
        return true;
      }
      if (src[p + 2] === '=') {
        if (p > start) { const h = src.slice(start, p); push('html', h); line += countNl(h); }
        i = p + 3; push('id', 'echo');
        return true;
      }
      if (shortTags && (p + 2 >= n || /\s/.test(src[p + 2]))) {
        if (p > start) { const h = src.slice(start, p); push('html', h); line += countNl(h); }
        i = p + 2;
        return true;
      }
      i = p + 2;
    }
    if (i > start) { const h = src.slice(start, i); push('html', h); line += countNl(h); }
    return false;
  }
  if (src.startsWith('#!')) { const e = src.indexOf('\n'); i = e < 0 ? n : e + 1; line = 2; }
  if (!htmlMode()) { push('eof', null); return toks; }

  while (i < n) {
    const c = src.charCodeAt(i);
    // whitespace
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12) { i++; continue; }
    if (c === 10) { line++; i++; continue; }
    const ch = src[i];
    // comments
    if (ch === '#' && src[i + 1] === '[') { // attribute: skip
      let depth = 0;
      while (i < n) {
        const d = src[i];
        if (d === '[') depth++;
        else if (d === ']') { depth--; if (depth === 0) { i++; break; } }
        else if (d === '\n') line++;
        else if (d === '"' || d === "'") { const q = d; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; } }
        i++;
      }
      continue;
    }
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') {
        if (src[i] === '?' && src[i + 1] === '>') break;
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      line += countNl(src.slice(i, end));
      i = end; continue;
    }
    // close tag
    if (ch === '?' && src[i + 1] === '>') {
      push('op', ';', { close: true });
      i += 2;
      if (src[i] === '\n') { i++; line++; } else if (src[i] === '\r' && src[i + 1] === '\n') { i += 2; line++; }
      if (!htmlMode()) break;
      continue;
    }
    // variables
    if (ch === '$' && i + 1 < n && isIdStart(src.charCodeAt(i + 1))) {
      let j = i + 1; while (j < n && isIdChar(src.charCodeAt(j))) j++;
      push('var', src.slice(i + 1, j)); i = j; continue;
    }
    // identifiers / names
    if (isIdStart(c) || (ch === '\\' && i + 1 < n && isIdStart(src.charCodeAt(i + 1)))) {
      let j = i; if (ch === '\\') j++;
      for (;;) {
        while (j < n && isIdChar(src.charCodeAt(j))) j++;
        if (src[j] === '\\' && j + 1 < n && isIdStart(src.charCodeAt(j + 1))) { j++; continue; }
        break;
      }
      const word = src.slice(i, j);
      i = j;
      const lw = word.toLowerCase();
      // heredoc is handled elsewhere; special keyword combos
      if (lw === 'yield') {
        const m = /^\s+from\b/i.exec(src.slice(i, i + 40));
        if (m) { line += countNl(m[0]); i += m[0].length; push('id', 'yield from'); continue; }
      }
      push('id', word);
      continue;
    }
    // numbers
    if ((c >= 48 && c <= 57) || (ch === '.' && i + 1 < n && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      let m;
      const stick = (re) => { re.lastIndex = i; return re.exec(src); };
      if ((m = stick(/0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*/y))) { i += m[0].length; pushInt(m[0].slice(2).replace(/_/g, ''), 16); continue; }
      if ((m = stick(/0[bB][01]+(?:_[01]+)*/y))) { i += m[0].length; pushInt(m[0].slice(2).replace(/_/g, ''), 2); continue; }
      if ((m = stick(/0[oO][0-7]+(?:_[0-7]+)*/y))) { i += m[0].length; pushInt(m[0].slice(2).replace(/_/g, ''), 8); continue; }
      m = stick(/(\d+(?:_\d+)*)?(\.\d+(?:_\d+)*|\.)?([eE][+-]?\d+(?:_\d+)*)?/y);
      let txt = m[0];
      if (txt.endsWith('.') && src[i + txt.length] === '.') txt = txt.slice(0, -1); // 1..2
      i += txt.length;
      const clean = txt.replace(/_/g, '');
      if (m[2] === undefined && m[3] === undefined || (txt === m[1])) {
        if (clean.length > 1 && clean[0] === '0') {
          if (!/^[0-7]+$/.test(clean)) err('Invalid numeric literal');
          pushInt(clean.slice(1), 8);
        } else pushInt(clean, 10);
      } else push('float', Number(clean));
      continue;
    }
    // strings
    if (ch === "'") {
      let j = i + 1, s = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && (src[j + 1] === "'" || src[j + 1] === '\\')) { s += src[j + 1]; j += 2; continue; }
        s += src[j]; j++;
      }
      if (j >= n) err('syntax error, unexpected end of file');
      push('str', s); line += countNl(s); i = j + 1; continue;
    }
    if (ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n && src[j] !== ch) { if (src[j] === '\\') j++; j++; }
      if (j >= n) err('syntax error, unexpected end of file');
      const raw = src.slice(i + 1, j);
      const startLine = line;
      const parts = interp(raw, ch === '"' ? '"' : '`', startLine);
      line += countNl(raw);
      i = j + 1;
      if (ch === '`') push('shell', parts, { l: startLine });
      else if (parts.length === 1 && typeof parts[0] === 'string') push('str', parts[0], { l: startLine });
      else if (parts.length === 0) push('str', '', { l: startLine });
      else push('tpl', parts, { l: startLine });
      continue;
    }
    // heredoc / nowdoc
    if (ch === '<' && src.startsWith('<<<', i)) {
      const m = /^<<<[ \t]*(["']?)([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)\1\r?\n/.exec(src.slice(i, i + 300));
      if (m) {
        const id = m[2], nowdoc = m[1] === "'";
        const bodyStart = i + m[0].length;
        const startLine = line;
        line++;
        // find closing marker: a line consisting of optional whitespace + id, followed by non-id char
        let p = bodyStart, found = -1, indent = '';
        const re = new RegExp('^([ \\t]*)' + id.replace(/[^\w]/g, '\\$&') + '(?![A-Za-z0-9_\\x80-\\xff])', 'gm');
        re.lastIndex = bodyStart;
        let mm;
        while ((mm = re.exec(src))) {
          if (mm.index === 0 || src[mm.index - 1] === '\n') { found = mm.index; indent = mm[1]; break; }
        }
        if (found < 0) err('syntax error, unexpected end of file');
        let body = found > bodyStart ? src.slice(bodyStart, found - 1) : '';
        if (body.endsWith('\r')) body = body.slice(0, -1);
        if (found === bodyStart) body = '';
        line += countNl(src.slice(bodyStart, found));
        i = found + indent.length + id.length;
        if (indent.length) {
          body = body.split('\n').map((ln) => {
            if (ln.startsWith(indent)) return ln.slice(indent.length);
            if (/^[ \t]*$/.test(ln)) return '';
            throw new ParseErr('Invalid body indentation level (expecting an indentation level of at least ' + indent.length + ')', startLine);
          }).join('\n');
        }
        if (nowdoc) push('str', body, { l: startLine });
        else {
          const parts = interp(body, 'h', startLine + 1);
          if (parts.length === 0) push('str', '', { l: startLine });
          else if (parts.length === 1 && typeof parts[0] === 'string') push('str', parts[0], { l: startLine });
          else push('tpl', parts, { l: startLine });
        }
        continue;
      }
    }
    // casts
    if (ch === '(') {
      const m = CAST_RE.exec(src.slice(i, i + 30));
      if (m) {
        let t = m[1].toLowerCase();
        t = { integer: 'int', boolean: 'bool', double: 'float', real: 'float', binary: 'string' }[t] || t;
        push('cast', t); i += m[0].length; continue;
      }
    }
    // operators
    const s3 = src.substr(i, 3);
    if (OPS3.includes(s3)) { push('op', s3); i += 3; continue; }
    const s2 = src.substr(i, 2);
    if (OPS2.includes(s2)) { push('op', s2); i += 2; continue; }
    if (OPS1.includes(ch)) { push('op', ch); i++; continue; }
    err(`syntax error, unexpected character 0x${c.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  push('eof', null);
  return toks;

  function pushInt(digits, base) {
    if (digits === '') digits = '0';
    let b;
    if (base === 10) b = BigInt(digits);
    else b = BigInt((base === 16 ? '0x' : base === 8 ? '0o' : '0b') + digits);
    if (b > I64MAX) push('float', Number(b));
    else push('int', normBig(b));
  }

  // process escapes and interpolation; returns array of string | {code, line}
  function interp(raw, mode, startLine) {
    const parts = [];
    let cur = '', j = 0, ln = startLine;
    const m = raw.length;
    const flush = () => { if (cur) { parts.push(cur); cur = ''; } };
    while (j < m) {
      const d = raw[j];
      if (d === '\n') ln++;
      if (d === '\\' && j + 1 < m) {
        const e = raw[j + 1];
        switch (e) {
          case 'n': cur += '\n'; j += 2; continue;
          case 't': cur += '\t'; j += 2; continue;
          case 'r': cur += '\r'; j += 2; continue;
          case 'v': cur += '\v'; j += 2; continue;
          case 'e': cur += '\x1b'; j += 2; continue;
          case 'f': cur += '\f'; j += 2; continue;
          case '\\': cur += '\\'; j += 2; continue;
          case '$': cur += '$'; j += 2; continue;
          case '{': cur += '\\{'; j += 2; continue;
          case '"': if (mode === '"') { cur += '"'; j += 2; continue; } break;
          case '`': if (mode === '`') { cur += '`'; j += 2; continue; } break;
          case 'u': {
            if (raw[j + 2] !== '{') break;
            const mm = /^\\u\{([0-9a-fA-F]+)\}/.exec(raw.slice(j, j + 40));
            if (!mm) throw new ParseErr('Invalid UTF-8 codepoint escape sequence', ln);
            const cpv = parseInt(mm[1], 16);
            if (cpv > 0x10FFFF) throw new ParseErr('Invalid UTF-8 codepoint escape sequence: Codepoint too large', ln);
            cur += encodeCodepoint(cpv); j += mm[0].length; continue;
          }
          case 'x': {
            const mm = /^\\x([0-9a-fA-F]{1,2})/.exec(raw.slice(j, j + 4));
            if (mm) { cur += String.fromCharCode(parseInt(mm[1], 16)); j += mm[0].length; continue; }
            break;
          }
          default:
            if (e >= '0' && e <= '7') {
              const mm = /^\\([0-7]{1,3})/.exec(raw.slice(j, j + 4));
              cur += String.fromCharCode(parseInt(mm[1], 8) & 255); j += mm[0].length; continue;
            }
        }
        cur += d; j++; continue;
      }
      if (d === '$' && j + 1 < m && isIdStart(raw.charCodeAt(j + 1))) {
        let k = j + 1; while (k < m && isIdChar(raw.charCodeAt(k))) k++;
        let code = '$' + raw.slice(j + 1, k);
        if (raw[k] === '[') {
          const mm = /^\[(?:(\$[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)|(-?\d+)|([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*))\]/.exec(raw.slice(k, k + 200));
          if (mm) {
            if (mm[1]) code += '[' + mm[1] + ']';
            else if (mm[2] !== undefined) code += /^-?(0|[1-9]\d*)$/.test(mm[2]) ? '[' + mm[2] + ']' : "['" + mm[2] + "']";
            else code += "['" + mm[3] + "']";
            k += mm[0].length;
          }
        } else if ((raw[k] === '-' && raw[k + 1] === '>' && isIdStart(raw.charCodeAt(k + 2))) || (raw[k] === '?' && raw[k + 1] === '-' && raw[k + 2] === '>' && isIdStart(raw.charCodeAt(k + 3)))) {
          const opLen = raw[k] === '?' ? 3 : 2;
          let q = k + opLen; while (q < m && isIdChar(raw.charCodeAt(q))) q++;
          code += raw.slice(k, q); k = q;
        }
        flush(); parts.push({ code, line: ln }); j = k; continue;
      }
      if (d === '{' && raw[j + 1] === '$') {
        const end = matchBrace(raw, j);
        flush(); parts.push({ code: raw.slice(j + 1, end), line: ln });
        ln += countNl(raw.slice(j, end)); j = end + 1; continue;
      }
      if (d === '$' && raw[j + 1] === '{') {
        const end = matchBrace(raw, j + 1);
        const inner = raw.slice(j + 2, end);
        let code;
        if (/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/.test(inner)) code = '$' + inner;
        else if (/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*\[/.test(inner)) code = '$' + inner;
        else code = '${' + inner + '}';
        flush(); parts.push({ code, line: ln }); j = end + 1; continue;
      }
      cur += d; j++;
    }
    flush();
    return parts;
  }
  function matchBrace(s, start) {
    let depth = 0;
    for (let k = start; k < s.length; k++) {
      const d = s[k];
      if (d === '{') depth++;
      else if (d === '}') { depth--; if (depth === 0) return k; }
      else if (d === "'" || d === '"') { const q = d; k++; while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++; } }
    }
    throw new ParseErr('syntax error, unexpected end of file', line);
  }
}

// ============================================================================
// Parser (recursive descent + Pratt expressions) -> AST
// ============================================================================
const BIN_BP = {
  'or': [1, 'L'], 'xor': [2, 'L'], 'and': [3, 'L'],
  '??': [8, 'R'], '||': [9, 'L'], '&&': [10, 'L'],
  '|': [11, 'L'], '^': [12, 'L'], '&': [13, 'L'],
  '==': [14, 'N'], '!=': [14, 'N'], '===': [14, 'N'], '!==': [14, 'N'], '<>': [14, 'N'], '<=>': [14, 'N'],
  '<': [15, 'N'], '<=': [15, 'N'], '>': [15, 'N'], '>=': [15, 'N'],
  '.': [16, 'L'], '<<': [17, 'L'], '>>': [17, 'L'],
  '+': [18, 'L'], '-': [18, 'L'], '*': [19, 'L'], '/': [19, 'L'], '%': [19, 'L'],
  'instanceof': [21, 'L'], '**': [22, 'R'],
};
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '.=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '??=']);
const RESERVED_TYPES = new Set(['int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'null', 'never', 'false', 'true', 'self', 'parent', 'static']);
const MAGIC = new Set(['__line__', '__file__', '__dir__', '__function__', '__class__', '__method__', '__namespace__', '__trait__']);
const LVAL_KINDS = new Set(['Var', 'VarVar', 'Index', 'Prop', 'SProp', 'List']);

class Parser {
  constructor(toks, file, shared) {
    this.toks = toks; this.p = 0; this.file = file;
    this.st = shared || { ns: '', uses: new Map(), useFns: new Map(), useConsts: new Map(), fnStack: [], clsStack: [], anonCount: 0, strict: false };
  }
  get tok() { return this.toks[this.p]; }
  peek(o = 1) { return this.toks[this.p + o] || this.toks[this.toks.length - 1]; }
  next() { return this.toks[this.p++]; }
  error(msg, tk) { tk = tk || this.tok; throw new ParseErr(msg, tk.l); }
  unexpected(tk) {
    tk = tk || this.tok;
    let d;
    switch (tk.t) {
      case 'eof': d = 'end of file'; break;
      case 'var': d = `variable "$${tk.v}"`; break;
      case 'id': d = `identifier "${tk.v}"`; break;
      case 'str': d = `double-quoted string "${tk.v}"`; break;
      case 'int': case 'float': d = `integer "${tk.v}"`; break;
      default: d = `token "${tk.v}"`;
    }
    this.error(`syntax error, unexpected ${d}`, tk);
  }
  isOp(v, o = 0) { const t = this.toks[this.p + o]; return t && t.t === 'op' && t.v === v; }
  isId(v, o = 0) { const t = this.toks[this.p + o]; return t && t.t === 'id' && t.v.toLowerCase() === v; }
  accept(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  acceptId(v) { if (this.isId(v)) { this.p++; return true; } return false; }
  expect(v) { if (!this.isOp(v)) this.unexpected(); return this.next(); }
  expectId(v) { if (!this.isId(v)) this.unexpected(); return this.next(); }
  ident() { const t = this.tok; if (t.t !== 'id') this.unexpected(); this.p++; return t.v; }
  semi() { if (this.accept(';')) return; if (this.tok.t === 'eof') return; this.unexpected(); }

  // ---------------------------------------------------------------- names
  resolveClass(name) {
    const ln = name.toLowerCase();
    if (name[0] === '\\') return name.slice(1);
    if (ln === 'self' || ln === 'parent' || ln === 'static') return ln;
    if (ln.startsWith('namespace\\')) return (this.st.ns ? this.st.ns + '\\' : '') + name.slice(10);
    const bs = name.indexOf('\\');
    const first = (bs < 0 ? name : name.slice(0, bs)).toLowerCase();
    if (this.st.uses.has(first)) return this.st.uses.get(first) + (bs < 0 ? '' : name.slice(bs));
    return this.st.ns ? this.st.ns + '\\' + name : name;
  }
  resolveFn(name) { // returns [name, fallback]
    if (name[0] === '\\') return [name.slice(1), null];
    const ln = name.toLowerCase();
    if (ln.startsWith('namespace\\')) return [(this.st.ns ? this.st.ns + '\\' : '') + name.slice(10), null];
    if (name.includes('\\')) return [this.resolveClass(name), null];
    if (this.st.useFns.has(ln)) return [this.st.useFns.get(ln), null];
    if (this.st.ns) return [this.st.ns + '\\' + name, name];
    return [name, null];
  }
  resolveConst(name) {
    if (name[0] === '\\') return [name.slice(1), null];
    if (name.includes('\\')) return [this.resolveClass(name), null];
    if (this.st.useConsts.has(name)) return [this.st.useConsts.get(name), null];
    if (this.st.ns) return [this.st.ns + '\\' + name, name];
    return [name, null];
  }
  nsName(name) { return this.st.ns ? this.st.ns + '\\' + name : name; }

  // ---------------------------------------------------------------- program
  parseProgram() {
    const body = [];
    while (this.tok.t !== 'eof') {
      const s = this.parseStatement(true);
      if (s) body.push(s);
    }
    return body;
  }

  parseBlockOrStatement() {
    if (this.isOp('{')) return this.parseBlock();
    const l = this.tok.l;
    return this.parseStatement() || { k: 'Block', body: [], l };
  }
  parseBlock() {
    const l = this.expect('{').l;
    const body = [];
    while (!this.isOp('}')) {
      if (this.tok.t === 'eof') this.unexpected();
      const s = this.parseStatement(); if (s) body.push(s);
    }
    this.p++;
    return { k: 'Block', body, l };
  }
  parseStmtsUntil(...ends) {
    const body = [];
    while (!ends.some((e) => this.isId(e))) {
      if (this.tok.t === 'eof') this.unexpected();
      const s = this.parseStatement(); if (s) body.push(s);
    }
    return { k: 'Block', body, l: this.tok.l };
  }

  parseStatement(top) {
    const t = this.tok, l = t.l;
    if (t.t === 'html') { this.p++; return { k: 'Echo', args: [{ k: 'Lit', v: t.v, l }], l }; }
    if (t.t === 'op') {
      if (t.v === '{') return this.parseBlock();
      if (t.v === ';') { this.p++; return null; }
    }
    if (t.t === 'id') {
      const kw = t.v.toLowerCase();
      const nx = this.peek();
      // label for goto: "name:" (unsupported, skip)
      switch (kw) {
        case 'echo': {
          this.p++;
          const args = [this.parseExpr()];
          while (this.accept(',')) args.push(this.parseExpr());
          this.semi();
          return { k: 'Echo', args, l };
        }
        case 'if': return this.parseIf();
        case 'while': {
          this.p++; this.expect('('); const c = this.parseExpr(); this.expect(')');
          let body;
          if (this.accept(':')) { body = this.parseStmtsUntil('endwhile'); this.p++; this.semi(); }
          else body = this.parseBlockOrStatement();
          return { k: 'While', c, body, l };
        }
        case 'do': {
          this.p++; const body = this.parseBlockOrStatement();
          this.expectId('while'); this.expect('('); const c = this.parseExpr(); this.expect(')'); this.semi();
          return { k: 'DoWhile', c, body, l };
        }
        case 'for': {
          this.p++; this.expect('(');
          const list = (end) => { const r = []; if (!this.isOp(end)) { r.push(this.parseExpr()); while (this.accept(',')) r.push(this.parseExpr()); } this.expect(end); return r; };
          const init = list(';'), cond = list(';'), step = list(')');
          let body;
          if (this.accept(':')) { body = this.parseStmtsUntil('endfor'); this.p++; this.semi(); }
          else body = this.parseBlockOrStatement();
          return { k: 'For', init, cond, step, body, l };
        }
        case 'foreach': {
          this.p++; this.expect('(');
          const e = this.parseExpr();
          this.expectId('as');
          let k = null, v, byRef = false;
          let first, firstRef = false;
          if (this.accept('&')) firstRef = true;
          first = this.parseExpr();
          if (this.accept('=>')) {
            if (firstRef) throw new ParseErr('Key element cannot be a reference', this.tok.l, 'Fatal error');
            k = first;
            if (this.accept('&')) byRef = true;
            v = this.parseExpr();
          } else { v = first; byRef = firstRef; }
          this.expect(')');
          if (v.k === 'Arr') v = this.toList(v);
          let body;
          if (this.accept(':')) { body = this.parseStmtsUntil('endforeach'); this.p++; this.semi(); }
          else body = this.parseBlockOrStatement();
          return { k: 'Foreach', e, kv: k, v, byRef, body, l };
        }
        case 'switch': {
          this.p++; this.expect('('); const e = this.parseExpr(); this.expect(')');
          const alt = !this.isOp('{');
          if (alt) this.expect(':'); else this.expect('{');
          this.accept(';');
          const cases = [];
          while (!(alt ? this.isId('endswitch') : this.isOp('}'))) {
            let test = null;
            if (this.acceptId('case')) test = this.parseExpr();
            else if (!this.acceptId('default')) this.unexpected();
            if (!this.accept(':') && !this.accept(';')) this.unexpected();
            const body = [];
            while (!this.isId('case') && !this.isId('default') && !this.isOp('}') && !this.isId('endswitch')) {
              if (this.tok.t === 'eof') this.unexpected();
              const s = this.parseStatement(); if (s) body.push(s);
            }
            cases.push({ test, body });
          }
          this.p++;
          if (alt) this.semi();
          return { k: 'Switch', e, cases, l };
        }
        case 'break': case 'continue': {
          this.p++;
          let n = 1;
          if (this.tok.t === 'int') n = this.next().v;
          this.semi();
          return { k: kw === 'break' ? 'Break' : 'Continue', n, l };
        }
        case 'return': {
          this.p++;
          let e = null;
          if (!this.isOp(';') && this.tok.t !== 'eof') e = this.parseExpr();
          this.semi();
          return { k: 'Return', e, l };
        }
        case 'function':
          if ((nx.t === 'id') || (nx.t === 'op' && nx.v === '&' && this.peek(2).t === 'id')) {
            this.p++;
            const byRef = this.accept('&');
            const name = this.ident();
            const fn = this.parseFunctionRest(this.nsName(name), byRef, l);
            return { k: 'FuncDecl', fn, l, top: !!top };
          }
          break;
        case 'abstract': case 'final': case 'class': case 'readonly':
          if (kw === 'class' && nx.t === 'id') return this.parseClass();
          if (kw !== 'class' && (nx.t === 'id')) {
            const nl = nx.v.toLowerCase();
            if (['abstract', 'final', 'class', 'readonly'].includes(nl)) return this.parseClass();
          }
          break;
        case 'interface': if (nx.t === 'id') return this.parseClass(); break;
        case 'trait': if (nx.t === 'id') return this.parseClass(); break;
        case 'enum': if (nx.t === 'id' && !(this.peek(2).t === 'op' && ['(', '=', '::'].includes(this.peek(2).v))) return this.parseClass(); break;
        case 'try': return this.parseTry();
        case 'global': {
          this.p++;
          const names = [];
          do {
            const v = this.tok;
            if (v.t === 'var') { this.p++; names.push(v.v); }
            else if (this.isOp('$')) names.push(this.parsePrimaryVarOnly());
            else this.unexpected();
          } while (this.accept(','));
          this.semi();
          return { k: 'Global', names, l };
        }
        case 'static':
          if (nx.t === 'var') {
            this.p++;
            const vars = [];
            do {
              const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
              let init = null; if (this.accept('=')) init = this.parseExpr();
              vars.push({ name: v.v, init });
            } while (this.accept(','));
            this.semi();
            return { k: 'StaticVar', vars, l };
          }
          break;
        case 'unset': {
          if (!(nx.t === 'op' && nx.v === '(')) break;
          this.p++; this.expect('(');
          const list = [];
          if (!this.isOp(')')) { list.push(this.parseExpr()); while (this.accept(',')) { if (this.isOp(')')) break; list.push(this.parseExpr()); } }
          this.expect(')'); this.semi();
          return { k: 'Unset', list, l };
        }
        case 'namespace': {
          if (nx.t === 'op' && nx.v === '\\') break;
          if (nx.t === 'id' && nx.v.toLowerCase().startsWith('namespace\\')) break;
          this.p++;
          let name = '';
          if (this.tok.t === 'id') name = this.next().v;
          this.st.ns = name; this.st.uses = new Map(); this.st.useFns = new Map(); this.st.useConsts = new Map();
          if (this.isOp('{')) {
            const b = this.parseBlock();
            b.top = true;
            return b;
          }
          this.semi();
          return null;
        }
        case 'use': {
          this.p++;
          let kind = 'class';
          if (this.isId('function')) { this.p++; kind = 'function'; } else if (this.isId('const')) { this.p++; kind = 'const'; }
          do {
            let name = this.ident();
            if (name[0] === '\\') name = name.slice(1);
            if (this.isOp('\\') || this.isOp('{') || name.endsWith('\\')) { // group use
              this.accept('\\');
              const prefix = name.replace(/\\$/, '');
              this.expect('{');
              do {
                if (this.isOp('}')) break;
                let k2 = kind;
                if (this.isId('function')) { this.p++; k2 = 'function'; } else if (this.isId('const')) { this.p++; k2 = 'const'; }
                const sub = this.ident();
                let alias = sub.split('\\').pop();
                if (this.acceptId('as')) alias = this.ident();
                this.addUse(k2, prefix + '\\' + sub, alias);
              } while (this.accept(','));
              this.expect('}');
            } else {
              let alias = name.split('\\').pop();
              if (this.acceptId('as')) alias = this.ident();
              this.addUse(kind, name, alias);
            }
          } while (this.accept(','));
          this.semi();
          return null;
        }
        case 'const': {
          this.p++;
          const items = [];
          do { const name = this.ident(); this.expect('='); items.push({ name: this.nsName(name), e: this.parseExpr() }); } while (this.accept(','));
          this.semi();
          return { k: 'ConstDecl', items, l };
        }
        case 'declare': {
          this.p++; this.expect('(');
          do { const name = this.ident().toLowerCase(); this.expect('='); const e = this.parseExpr(); if (name === 'strict_types') this.st.strict = e.k === 'Lit' && toBool(e.v); } while (this.accept(','));
          this.expect(')');
          if (this.isOp('{')) return this.parseBlock();
          if (this.accept(':')) { const b = this.parseStmtsUntil('enddeclare'); this.p++; this.semi(); return b; }
          this.semi();
          return null;
        }
        case '__halt_compiler': {
          this.p = this.toks.length - 1;
          return null;
        }
        case 'goto': this.error("'goto' is not supported");
      }
    }
    const e = this.parseExpr();
    this.semi();
    return { k: 'ExprStmt', e, l };
  }
  addUse(kind, name, alias) {
    if (kind === 'function') this.st.useFns.set(alias.toLowerCase(), name);
    else if (kind === 'const') this.st.useConsts.set(alias, name);
    else this.st.uses.set(alias.toLowerCase(), name);
  }

  parseIf() {
    const l = this.next().l;
    this.expect('('); const c = this.parseExpr(); this.expect(')');
    if (this.accept(':')) {
      const then = this.parseStmtsUntil('elseif', 'else', 'endif');
      const elifs = []; let els = null;
      for (;;) {
        if (this.acceptId('elseif')) { this.expect('('); const c2 = this.parseExpr(); this.expect(')'); this.expect(':'); elifs.push({ c: c2, body: this.parseStmtsUntil('elseif', 'else', 'endif') }); continue; }
        if (this.acceptId('else')) {
          if (this.isId('if')) { this.p++; this.expect('('); const c2 = this.parseExpr(); this.expect(')'); this.expect(':'); elifs.push({ c: c2, body: this.parseStmtsUntil('elseif', 'else', 'endif') }); continue; }
          this.expect(':'); els = this.parseStmtsUntil('endif'); continue;
        }
        break;
      }
      this.expectId('endif'); this.semi();
      return { k: 'If', c, then, elifs, els, l };
    }
    const then = this.parseBlockOrStatement();
    const elifs = []; let els = null;
    for (;;) {
      if (this.isId('elseif')) { this.p++; this.expect('('); const c2 = this.parseExpr(); this.expect(')'); elifs.push({ c: c2, body: this.parseBlockOrStatement() }); continue; }
      if (this.isId('else')) {
        this.p++;
        if (this.isId('if')) { this.p++; this.expect('('); const c2 = this.parseExpr(); this.expect(')'); elifs.push({ c: c2, body: this.parseBlockOrStatement() }); continue; }
        els = this.parseBlockOrStatement();
      }
      break;
    }
    return { k: 'If', c, then, elifs, els, l };
  }

  parseTry() {
    const l = this.next().l;
    const body = this.parseBlock();
    const catches = []; let fin = null;
    while (this.acceptId('catch')) {
      this.expect('(');
      const types = [this.resolveClass(this.ident())];
      while (this.accept('|')) types.push(this.resolveClass(this.ident()));
      let v = null;
      if (this.tok.t === 'var') v = this.next().v;
      this.expect(')');
      catches.push({ types, v, body: this.parseBlock() });
    }
    if (this.acceptId('finally')) fin = this.parseBlock();
    if (!catches.length && !fin) this.error('Cannot use try without catch or finally');
    return { k: 'Try', body, catches, fin, l };
  }

  // ---------------------------------------------------------------- types
  parseType() {
    if (this.accept('?')) { const t = this.parseSingleType(); return { alts: [t], nullable: true }; }
    const alts = [];
    let inter = false;
    for (;;) {
      if (this.accept('(')) { // DNF group
        const g = [this.parseSingleType()];
        while (this.accept('&')) g.push(this.parseSingleType());
        this.expect(')');
        alts.push({ inter: g });
      } else alts.push(this.parseSingleType());
      if (this.isOp('|')) { this.p++; continue; }
      if (this.isOp('&') && !(this.peek().t === 'var' || (this.peek().t === 'op' && (this.peek().v === '...' || this.peek().v === '&')))) { this.p++; inter = true; continue; }
      break;
    }
    if (inter) return { alts: [{ inter: alts }], nullable: false };
    const nullable = alts.some((a) => a === 'null' || a === 'mixed');
    return { alts: alts.filter((a) => a !== 'null'), nullable };
  }
  parseSingleType() {
    const name = this.ident();
    const ln = name.toLowerCase();
    if (RESERVED_TYPES.has(ln)) return ln;
    return this.resolveClass(name);
  }
  atTypeStart() {
    const t = this.tok;
    if (t.t === 'op' && (t.v === '?' || t.v === '(')) return true;
    return t.t === 'id';
  }

  // ---------------------------------------------------------------- functions
  parseParams() {
    this.expect('(');
    const params = [];
    while (!this.isOp(')')) {
      const prm = { name: null, def: null, byRef: false, variadic: false, type: null, promote: null, readonly: false };
      for (;;) {
        if (this.isId('public') || this.isId('protected') || this.isId('private')) { prm.promote = this.next().v.toLowerCase(); continue; }
        if (this.isId('readonly')) { this.p++; prm.readonly = true; if (!prm.promote) prm.promote = 'public'; continue; }
        break;
      }
      if (this.tok.t !== 'var' && !this.isOp('&') && !this.isOp('...')) prm.type = this.parseType();
      if (this.accept('&')) prm.byRef = true;
      if (this.accept('...')) prm.variadic = true;
      const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
      prm.name = v.v;
      if (this.accept('=')) prm.def = this.parseExpr();
      params.push(prm);
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return params;
  }
  parseFunctionRest(name, byRef, l, opts = {}) {
    const fn = { name, byRef, params: null, ret: null, body: null, isGen: false, l, file: this.file, strict: false, static: !!opts.static };
    if (opts.cls !== undefined) fn.cls = opts.cls;
    fn.params = this.parseParams();
    if (opts.closure && this.acceptId('use')) {
      this.expect('(');
      fn.uses = [];
      while (!this.isOp(')')) {
        const r = this.accept('&'); const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
        fn.uses.push({ name: v.v, byRef: r });
        if (!this.accept(',')) break;
      }
      this.expect(')');
    }
    if (this.accept(':')) fn.ret = this.parseType();
    if (this.isOp('{')) {
      this.st.fnStack.push(fn);
      const b = this.parseBlock();
      this.st.fnStack.pop();
      fn.body = b.body;
    } else { this.semi(); fn.body = null; }
    fn.strict = this.st.strict;
    return fn;
  }

  // ---------------------------------------------------------------- classes
  parseClass(anonArgs) {
    const l = this.tok.l;
    const flags = { abstract: false, final: false, readonly: false };
    while (this.isId('abstract') || this.isId('final') || this.isId('readonly')) flags[this.next().v.toLowerCase()] = true;
    const kind = this.ident().toLowerCase(); // class|interface|trait|enum
    let name;
    if (anonArgs !== undefined) name = 'class@anonymous';
    else name = this.nsName(this.ident());
    const cd = { k: 'ClassDecl', kind, name, parent: null, interfaces: [], flags, consts: [], props: [], methods: [], traits: [], cases: [], enumType: null, l, file: this.file, anon: anonArgs !== undefined };
    if (kind === 'enum' && this.accept(':')) cd.enumType = this.parseType();
    if (this.acceptId('extends')) {
      if (kind === 'interface') { do cd.interfaces.push(this.resolveClass(this.ident())); while (this.accept(',')); }
      else cd.parent = this.resolveClass(this.ident());
    }
    if (this.acceptId('implements')) { do cd.interfaces.push(this.resolveClass(this.ident())); while (this.accept(',')); }
    this.st.clsStack.push(cd);
    this.expect('{');
    while (!this.accept('}')) {
      if (this.tok.t === 'eof') this.unexpected();
      this.parseMember(cd);
    }
    this.st.clsStack.pop();
    return cd;
  }
  parseMember(cd) {
    const l = this.tok.l;
    if (this.acceptId('use')) {
      const names = [this.resolveClass(this.ident())];
      while (this.accept(',')) names.push(this.resolveClass(this.ident()));
      const rules = [];
      if (this.accept('{')) {
        while (!this.accept('}')) {
          let tn = null, m = this.ident();
          if (this.accept('::')) { tn = this.resolveClass(m); m = this.ident(); }
          if (this.acceptId('insteadof')) {
            const ex = [this.resolveClass(this.ident())]; while (this.accept(',')) ex.push(this.resolveClass(this.ident()));
            rules.push({ kind: 'insteadof', trait: tn, method: m, excl: ex });
          } else {
            this.expectId('as');
            let vis = null, alias = null;
            if (this.isId('public') || this.isId('protected') || this.isId('private')) vis = this.next().v.toLowerCase();
            if (this.tok.t === 'id') alias = this.ident();
            rules.push({ kind: 'as', trait: tn, method: m, vis, alias });
          }
          this.semi();
        }
      } else this.semi();
      cd.traits.push({ names, rules });
      return;
    }
    if (this.acceptId('case')) {
      const name = this.ident();
      let e = null; if (this.accept('=')) e = this.parseExpr();
      this.semi();
      cd.cases.push({ name, e, l });
      return;
    }
    const mods = { vis: null, static: false, abstract: false, final: false, readonly: cd.flags.readonly, var: false };
    for (;;) {
      if (this.isId('public') || this.isId('protected') || this.isId('private')) { mods.vis = this.next().v.toLowerCase(); continue; }
      if (this.isId('static') && !this.isOp('::', 1)) { this.p++; mods.static = true; continue; }
      if (this.isId('abstract')) { this.p++; mods.abstract = true; continue; }
      if (this.isId('final')) { this.p++; mods.final = true; continue; }
      if (this.isId('readonly')) { this.p++; mods.readonly = true; continue; }
      if (this.isId('var')) { this.p++; mods.var = true; continue; }
      break;
    }
    if (this.acceptId('const')) {
      // optional type
      if (this.tok.t === 'id' && this.peek().t === 'id') this.parseType();
      else if (this.isOp('?')) this.parseType();
      do {
        const name = this.ident(); this.expect('=');
        cd.consts.push({ name, e: this.parseExpr(), vis: mods.vis || 'public', final: mods.final, l });
      } while (this.accept(','));
      this.semi();
      return;
    }
    if (this.acceptId('function')) {
      const byRef = this.accept('&');
      const nameTok = this.tok; if (nameTok.t !== 'id') this.unexpected(); this.p++;
      const fn = this.parseFunctionRest(nameTok.v, byRef, l, { cls: cd.name });
      fn.cls = cd.name;
      cd.methods.push({ fn, vis: mods.vis || 'public', static: mods.static, abstract: mods.abstract || cd.kind === 'interface', final: mods.final, l });
      return;
    }
    // property
    let type = null;
    if (this.tok.t !== 'var') type = this.parseType();
    do {
      const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
      let def; let hasDef = false;
      if (this.accept('=')) { def = this.parseExpr(); hasDef = true; }
      cd.props.push({ name: v.v, def: hasDef ? def : null, hasDef, static: mods.static, vis: mods.vis || 'public', type, readonly: mods.readonly, l });
    } while (this.accept(','));
    if (this.isOp('{')) this.error('Property hooks are not supported');
    this.semi();
  }

  // ---------------------------------------------------------------- expressions
  parseExpr(minBp = 0) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.tok;
      let op;
      if (t.t === 'op') op = t.v;
      else if (t.t === 'id') { op = t.v.toLowerCase(); if (!(op === 'or' || op === 'xor' || op === 'and' || op === 'instanceof')) break; }
      else break;
      if (ASSIGN_OPS.has(op)) {
        if (!LVAL_KINDS.has(left.k) && left.k !== 'Arr') break;
        if (minBp > 5 && !(left.k === 'Var' || left.k === 'Index' || left.k === 'Prop' || left.k === 'SProp' || left.k === 'VarVar')) break;
        this.p++;
        const l = t.l;
        if (op === '=') {
          if (this.isOp('&')) {
            this.p++;
            const e = this.parseExpr(5);
            left = { k: 'AssignRef', t: left, e, l };
          } else {
            let target = left;
            if (target.k === 'Arr') target = this.toList(target);
            left = { k: 'Assign', t: target, e: this.parseExpr(5), l };
          }
        } else {
          if (left.k === 'Arr') this.unexpected(t);
          left = { k: 'AssignOp', op: op.slice(0, -1), t: left, e: this.parseExpr(5), l };
        }
        continue;
      }
      if (op === '?') {
        if (minBp > 7) break;
        this.p++;
        if (this.accept(':')) { const b = this.parseExpr(8); left = { k: 'Ternary', c: left, a: null, b, l: t.l }; continue; }
        const a = this.parseExpr(0);
        this.expect(':');
        const b = this.parseExpr(8);
        left = { k: 'Ternary', c: left, a, b, l: t.l };
        continue;
      }
      const info = BIN_BP[op];
      if (!info) break;
      const [bp, assoc] = info;
      if (bp < minBp) break;
      this.p++;
      if (op === 'instanceof') {
        let cls;
        if (this.tok.t === 'id') { cls = this.resolveClass(this.next().v); }
        else cls = this.parseUnary();
        left = { k: 'Instanceof', e: left, cls, l: t.l };
        continue;
      }
      const right = this.parseExpr(assoc === 'R' ? bp : bp + 1);
      if (op === '&&' || op === 'and') left = { k: 'And', a: left, b: right, l: t.l };
      else if (op === '||' || op === 'or') left = { k: 'Or', a: left, b: right, l: t.l };
      else if (op === 'xor') left = { k: 'Xor', a: left, b: right, l: t.l };
      else if (op === '??') left = { k: 'Coalesce', a: left, b: right, l: t.l };
      else left = { k: 'Bin', op: op === '<>' ? '!=' : op, a: left, b: right, l: t.l };
    }
    return left;
  }

  toList(arr) {
    const items = arr.items.map((it) => {
      if (!it) return null;
      let v = it.v;
      if (v.k === 'Arr') v = this.toList(v);
      return { key: it.key, v, byRef: it.byRef };
    });
    return { k: 'List', items, l: arr.l };
  }

  parseUnary() {
    const t = this.tok, l = t.l;
    if (t.t === 'op') {
      switch (t.v) {
        case '!': this.p++; return { k: 'Not', e: this.parseExpr(20), l };
        case '-': {
          this.p++;
          const nt = this.tok;
          if ((nt.t === 'int' || nt.t === 'float') && !(this.peek().t === 'op' && this.peek().v === '**')) {
            // negative literal (handles PHP_INT_MIN)
            this.p++;
            const v = nt.t === 'int' ? neg(nt.v) : mkf(-nt.v);
            if (nt.t === 'int' && typeof nt.v === 'bigint' && nt.v === 9223372036854775808n) return this.parsePostfix({ k: 'Lit', v: I64MIN, l });
            return this.parsePostfix({ k: 'Lit', v, l });
          }
          return { k: 'Neg', e: this.parseExpr(20), l };
        }
        case '+': this.p++; return { k: 'Plus', e: this.parseExpr(20), l };
        case '~': this.p++; return { k: 'BitNot', e: this.parseExpr(20), l };
        case '@': this.p++; return { k: 'Silence', e: this.parseExpr(20), l };
        case '++': this.p++; return { k: 'PreInc', e: this.parseUnary(), l };
        case '--': this.p++; return { k: 'PreDec', e: this.parseUnary(), l };
        case '&': this.error('syntax error, unexpected token "&"');
      }
    }
    if (t.t === 'cast') { this.p++; return { k: 'Cast', t: t.v, e: this.parseExpr(20), l }; }
    if (t.t === 'id') {
      const kw = t.v.toLowerCase();
      switch (kw) {
        case 'new': return this.parsePostfix(this.parseNew());
        case 'clone': this.p++; return { k: 'Clone', e: this.parseUnary(), l };
        case 'print': this.p++; return { k: 'Print', e: this.parseExpr(4), l };
        case 'yield': {
          this.p++;
          const fn = this.st.fnStack[this.st.fnStack.length - 1];
          if (fn) fn.isGen = true; else this.error('The "yield" expression can only be used inside a function');
          if (this.isOp(';') || this.isOp(')') || this.isOp(',') || this.isOp(']') || this.tok.t === 'eof') return { k: 'Yield', key: null, v: null, l };
          let v = this.parseExpr(4), key = null;
          if (this.accept('=>')) { key = v; v = this.parseExpr(4); }
          return { k: 'Yield', key, v, l };
        }
        case 'yield from': {
          this.p++;
          const fn = this.st.fnStack[this.st.fnStack.length - 1];
          if (fn) fn.isGen = true; else this.error('The "yield" expression can only be used inside a function');
          return { k: 'YieldFrom', e: this.parseExpr(4), l };
        }
        case 'throw': this.p++; return { k: 'Throw', e: this.parseExpr(0), l };
        case 'include': case 'include_once': case 'require': case 'require_once':
          this.p++; return { k: 'Include', kind: kw, e: this.parseExpr(4), l };
      }
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parseNew() {
    const l = this.next().l;
    let cls;
    if (this.isId('class')) {
      // anonymous class
      this.p++;
      let args = [];
      if (this.isOp('(')) args = this.parseArgs();
      this.p--; // re-point at 'class' keyword for parseClass
      this.toks[this.p] = { t: 'id', v: 'class', l };
      const cd = this.parseClass(args);
      cd.name = 'class@anonymous' + (++this.st.anonCount);
      return { k: 'New', cls: cd, args, l };
    }
    if (this.tok.t === 'id') {
      const name = this.next().v;
      cls = this.resolveClass(name);
    } else if (this.tok.t === 'var') {
      cls = { k: 'Var', name: this.next().v, l };
      // allow $obj->prop / $a['x'] / Foo::$x as class name expression
      for (;;) {
        if (this.isOp('->') || this.isOp('?->')) { const ns = this.next().v === '?->'; const nm = this.tok.t === 'id' ? this.next().v : this.parseExpr(); cls = { k: 'Prop', o: cls, name: nm, nullsafe: ns, l }; continue; }
        if (this.isOp('[')) { this.p++; const i = this.parseExpr(); this.expect(']'); cls = { k: 'Index', o: cls, i, l }; continue; }
        if (this.isOp('::') && this.peek().t === 'var') { this.p++; cls = { k: 'SProp', cls, name: this.next().v, l }; continue; }
        break;
      }
    } else if (this.accept('(')) {
      cls = this.parseExpr(); this.expect(')');
    } else if (this.isId('static')) { this.p++; cls = 'static'; }
    else this.unexpected();
    let args = [];
    if (this.isOp('(')) args = this.parseArgs();
    return { k: 'New', cls, args, l };
  }

  parseArgs() {
    this.expect('(');
    const args = [];
    if (this.isOp('...') && this.peek().t === 'op' && this.peek().v === ')') { this.p += 2; return 'fcc'; }
    while (!this.isOp(')')) {
      if (this.accept('...')) { args.push({ e: this.parseExpr(), spread: true }); }
      else if (this.tok.t === 'id' && this.isOp(':', 1) && !this.isOp('::', 1)) {
        const name = this.next().v; this.p++;
        args.push({ e: this.parseExpr(), name });
      } else args.push({ e: this.parseExpr() });
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return args;
  }

  parseArrayItems(close) {
    const items = [];
    while (!this.isOp(close)) {
      if (this.isOp(',')) { this.p++; items.push(null); continue; }
      if (this.accept('...')) { items.push({ key: null, v: this.parseExpr(), spread: true }); }
      else if (this.accept('&')) { items.push({ key: null, v: this.parseExpr(), byRef: true }); }
      else {
        let v = this.parseExpr(), key = null, byRef = false;
        if (this.accept('=>')) { key = v; if (this.accept('&')) byRef = true; v = this.parseExpr(); }
        items.push({ key, v, byRef });
      }
      if (!this.accept(',')) break;
    }
    this.expect(close);
    return items;
  }

  parseClosure(isStatic) {
    const l = this.tok.l;
    if (this.acceptId('fn')) {
      const byRef = this.accept('&');
      const fn = { name: '{closure}', byRef, params: this.parseParams(), ret: null, body: null, isGen: false, l, file: this.file, arrow: true, static: isStatic, strict: this.st.strict };
      if (this.accept(':')) fn.ret = this.parseType();
      this.expect('=>');
      this.st.fnStack.push(fn);
      const e = this.parseExpr(5);
      this.st.fnStack.pop();
      fn.body = [{ k: 'Return', e, l: e.l }];
      fn.arrowExpr = e;
      return { k: 'Closure', fn, l };
    }
    this.expectId('function');
    const byRef = this.accept('&');
    const fn = this.parseFunctionRest('{closure}', byRef, l, { closure: true, static: isStatic });
    return { k: 'Closure', fn, l };
  }

  parsePrimary() {
    const t = this.tok, l = t.l;
    switch (t.t) {
      case 'var': this.p++; return { k: 'Var', name: t.v, l };
      case 'int': this.p++; return { k: 'Lit', v: t.v, l };
      case 'float': this.p++; return { k: 'Lit', v: mkf(t.v), l };
      case 'str': this.p++; return { k: 'Lit', v: t.v, l };
      case 'tpl': this.p++; return { k: 'Interp', parts: this.interpParts(t.v), l };
      case 'shell': this.p++; return { k: 'Shell', parts: this.interpParts(t.v), l };
      case 'op':
        if (t.v === '(') { this.p++; const e = this.parseExpr(); this.expect(')'); return e; }
        if (t.v === '[') { this.p++; return { k: 'Arr', items: this.parseArrayItems(']'), l }; }
        if (t.v === '$') {
          this.p++;
          if (this.accept('{')) { const e = this.parseExpr(); this.expect('}'); return { k: 'VarVar', e, l }; }
          return { k: 'VarVar', e: this.parsePrimaryVarOnly(), l };
        }
        if (t.v === '&') this.error('syntax error, unexpected token "&"');
        this.unexpected();
      // falls through
      case 'id': {
        const kw = t.v.toLowerCase();
        const nx = this.peek();
        const nxOp = nx.t === 'op' ? nx.v : null;
        switch (kw) {
          case 'true': if (nxOp !== '::' && nxOp !== '\\') { this.p++; return { k: 'Lit', v: true, l }; } break;
          case 'false': if (nxOp !== '::') { this.p++; return { k: 'Lit', v: false, l }; } break;
          case 'null': if (nxOp !== '::') { this.p++; return { k: 'Lit', v: null, l }; } break;
          case 'array': if (nxOp === '(') { this.p += 2; return { k: 'Arr', items: this.parseArrayItems(')'), l }; } break;
          case 'list': if (nxOp === '(') { this.p += 2; return this.toList({ k: 'Arr', items: this.parseArrayItems(')'), l }); } break;
          case 'eval': {
            if (nxOp !== '(') break;
            this.p++; this.expect('('); const e = this.parseExpr(); this.expect(')');
            return { k: 'Eval', e, l, ns: this.st.ns, uses: this.st.uses, useFns: this.st.useFns, useConsts: this.st.useConsts };
          }
          case 'isset': {
            this.p++; this.expect('(');
            const list = [this.parseExpr()]; while (this.accept(',')) { if (this.isOp(')')) break; list.push(this.parseExpr()); }
            this.expect(')');
            return { k: 'Isset', list, l };
          }
          case 'empty': { this.p++; this.expect('('); const e = this.parseExpr(); this.expect(')'); return { k: 'Empty', e, l }; }
          case 'exit': case 'die': {
            this.p++;
            let e = null;
            if (this.accept('(')) { if (!this.isOp(')')) e = this.parseExpr(); this.expect(')'); }
            return { k: 'Exit', e, l };
          }
          case 'function': case 'fn': return this.parseClosure(false);
          case 'static':
            if (nx.t === 'id' && (nx.v.toLowerCase() === 'function' || nx.v.toLowerCase() === 'fn')) { this.p++; return this.parseClosure(true); }
            break;
          case 'match': if (nxOp === '(') return this.parseMatch(); break;
          case 'new': return this.parseNew();
        }
        if (MAGIC.has(kw) && nxOp !== '(' && nxOp !== '::') {
          this.p++;
          return this.magic(kw, l);
        }
        this.p++;
        const name = t.v;
        if (nxOp === '(') {
          const [fname, fb] = this.resolveFn(name);
          const args = this.parseArgs();
          return { k: 'Call', f: fname, fb, args, l };
        }
        if (nxOp === '::') return { k: 'Name', name: this.resolveClass(name), l };
        const [cname, fb] = this.resolveConst(name);
        return { k: 'Const', name: cname, fb, l };
      }
      case 'cast': return this.parseUnary();
    }
    this.unexpected();
  }
  parsePrimaryVarOnly() {
    const t = this.tok;
    if (t.t === 'var') { this.p++; return { k: 'Var', name: t.v, l: t.l }; }
    if (this.isOp('$')) { this.p++; if (this.accept('{')) { const e = this.parseExpr(); this.expect('}'); return { k: 'VarVar', e, l: t.l }; } return { k: 'VarVar', e: this.parsePrimaryVarOnly(), l: t.l }; }
    this.unexpected();
  }
  magic(kw, l) {
    const fn = this.st.fnStack[this.st.fnStack.length - 1];
    const cd = this.st.clsStack[this.st.clsStack.length - 1];
    switch (kw) {
      case '__line__': return { k: 'Lit', v: l, l };
      case '__file__': return { k: 'Lit', v: this.file, l };
      case '__dir__': return { k: 'Lit', v: pathMod.dirname(this.file), l };
      case '__namespace__': return { k: 'Lit', v: this.st.ns, l };
      case '__function__': return { k: 'Lit', v: fn ? (fn.name === '{closure}' ? '{closure}' : fn.name) : '', l };
      case '__class__': return cd && cd.kind !== 'trait' && !cd.anon ? { k: 'Lit', v: cd.name, l } : { k: 'MagicClass', l };
      case '__trait__': return { k: 'Lit', v: cd && cd.kind === 'trait' ? cd.name : '', l };
      case '__method__': {
        if (!fn) return { k: 'Lit', v: '', l };
        if (cd && fn.cls !== undefined) return cd.kind === 'trait' ? { k: 'MagicMethod', name: fn.name, l } : { k: 'Lit', v: (cd.anon ? 'class@anonymous' : cd.name) + '::' + fn.name, l };
        return { k: 'Lit', v: fn.name, l };
      }
    }
  }
  parseMatch() {
    const l = this.next().l;
    this.expect('('); const e = this.parseExpr(); this.expect(')');
    this.expect('{');
    const arms = [];
    while (!this.accept('}')) {
      let conds = null;
      if (this.acceptId('default')) { /* default arm */ }
      else { conds = [this.parseExpr()]; while (this.accept(',')) { if (this.isOp('=>')) break; conds.push(this.parseExpr()); } }
      this.expect('=>');
      const body = this.parseExpr();
      arms.push({ conds, body });
      if (!this.accept(',')) { this.expect('}'); break; }
    }
    return { k: 'Match', e, arms, l };
  }

  parsePostfix(e) {
    for (;;) {
      const t = this.tok;
      if (t.t !== 'op') break;
      const l = t.l;
      switch (t.v) {
        case '[': {
          this.p++;
          if (this.accept(']')) { e = { k: 'Index', o: e, i: null, l }; continue; }
          const i = this.parseExpr(); this.expect(']');
          e = { k: 'Index', o: e, i, l }; continue;
        }
        case '{': {
          if (e.k === 'Var' || e.k === 'Index' || e.k === 'Prop') this.error('syntax error, unexpected token "{"');
          return e;
        }
        case '->': case '?->': {
          this.p++;
          const nullsafe = t.v === '?->';
          let name;
          const nt = this.tok;
          if (nt.t === 'id') { this.p++; name = nt.v; }
          else if (nt.t === 'var') { this.p++; name = { k: 'Var', name: nt.v, l: nt.l }; }
          else if (this.accept('{')) { name = this.parseExpr(); this.expect('}'); }
          else if (nt.t === 'op' && nt.v === '$') name = this.parsePrimaryVarOnly();
          else this.unexpected();
          if (this.isOp('(')) { const args = this.parseArgs(); e = { k: 'MCall', o: e, name, args, nullsafe, l }; }
          else e = { k: 'Prop', o: e, name, nullsafe, l };
          continue;
        }
        case '::': {
          this.p++;
          const cls = e.k === 'Name' ? e.name : e;
          const nt = this.tok;
          if (nt.t === 'var') {
            this.p++;
            if (this.isOp('(')) { // A::$fn() calls the static method named by $fn
              const args = this.parseArgs();
              e = { k: 'SCall', cls, name: { k: 'Var', name: nt.v, l }, args, l };
            } else e = { k: 'SProp', cls, name: nt.v, l };
            continue;
          }
          if (nt.t === 'op' && nt.v === '$') {
            const ne = this.parsePrimaryVarOnly();
            if (this.isOp('(')) { const args = this.parseArgs(); e = { k: 'SCall', cls, name: ne, args, l }; continue; }
            e = { k: 'SProp', cls, name: ne.k === 'VarVar' ? ne.e : ne, l }; continue;
          }
          if (nt.t === 'op' && nt.v === '{') { this.p++; const ne = this.parseExpr(); this.expect('}'); const args = this.parseArgs(); e = { k: 'SCall', cls, name: ne, args, l }; continue; }
          if (nt.t !== 'id') this.unexpected();
          this.p++;
          if (this.isOp('(')) { const args = this.parseArgs(); e = { k: 'SCall', cls, name: nt.v, args, l }; continue; }
          if (nt.v.toLowerCase() === 'class') { e = { k: 'ClassName', cls, l }; continue; }
          e = { k: 'CConst', cls, name: nt.v, l };
          continue;
        }
        case '(': {
          if (e.k === 'Lit' || e.k === 'Name') return e;
          const args = this.parseArgs();
          e = { k: 'Call', f: e, args, l };
          continue;
        }
        case '++': this.p++; e = { k: 'PostInc', e, l }; continue;
        case '--': this.p++; e = { k: 'PostDec', e, l }; continue;
      }
      break;
    }
    if (e.k === 'Name') return { k: 'Const', name: e.name, fb: null, l: e.l };
    return e;
  }

  interpParts(parts) {
    return parts.map((p) => {
      if (typeof p === 'string') return p;
      const toks = lex('<?php ' + p.code + ';', this.file);
      for (const tk of toks) tk.l += p.line - 1;
      const sub = new Parser(toks, this.file, this.st);
      const e = sub.parseExpr();
      if (!sub.isOp(';')) sub.unexpected();
      return e;
    });
  }
}

function parsePHP(src, file) {
  const toks = lex(src, file);
  const p = new Parser(toks, file);
  return p.parseProgram();
}

// ============================================================================
// Compiler: AST -> JS closures
// ============================================================================
const BREAK1 = { t: 1, n: 1 }, CONT1 = { t: 2, n: 1 }, RETURN = { t: 3 };
const mkBreak = (n) => (n === 1 ? BREAK1 : { t: 1, n });
const mkCont = (n) => (n === 1 ? CONT1 : { t: 2, n });
const SUPERGLOBALS = new Set(['_SERVER', '_GET', '_POST', '_ENV', '_COOKIE', '_FILES', '_REQUEST', '_SESSION']);

function Vars() {}
Vars.prototype = Object.create(null);
class Frame {
  constructor(fn, thisObj, cls, sc) {
    this.vars = new Vars();
    this.fn = fn; this.this = thisObj; this.cls = cls; this.sc = sc;
    this.ret = null; this.args = null; this.temps = null; this.statics = null; this.closure = null;
    this.callLine = 0; this.callFile = ''; this.retRef = null; this.destr = null; this.gen = null;
  }
}

function isFresh(n) { // expressions producing a new value (no copy marking needed)
  switch (n.k) {
    case 'Lit': case 'Interp': case 'Bin': case 'New': case 'Not': case 'Neg': case 'Cast': case 'Isset': case 'Empty': case 'Closure': return true;
    case 'Arr': return true;
  }
  return false;
}
const isLvalNode = (n) => LVAL_KINDS.has(n.k);

function hasYield(n) {
  if (n === null || typeof n !== 'object') return false;
  if (n._hy !== undefined) return n._hy;
  let r = false;
  if (n.k === 'Yield' || n.k === 'YieldFrom') r = true;
  else if (n.k === 'Closure' || n.k === 'ClassDecl' || n.k === 'FuncDecl') r = false;
  else if (Array.isArray(n)) r = n.some(hasYield);
  else {
    for (const key in n) {
      if (key === 'l' || key === '_hy') continue;
      const v = n[key];
      if (v && typeof v === 'object' && hasYield(v)) { r = true; break; }
    }
  }
  if (!Array.isArray(n)) n._hy = r;
  return r;
}

// collect variables used in an arrow function body (for auto-capture)
function arrowFreeVars(fn) {
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
function warnUndefVar(name) { warn(`Undefined variable $${name}`); }
function keyRepr(k) { return typeof k === 'string' ? `"${k}"` : String(k); }

// ---------------------------------------------------------------- array/string reads
function readIndex(base, key, quiet) {
  if (base instanceof PHPArray) {
    const k = normKey(key);
    const i = base.index(k);
    if (i === undefined) { if (!quiet) warn(`Undefined array key ${keyRepr(k)}`); return quiet ? undefined : null; }
    const v = base.v[i];
    return v instanceof Ref ? v.v : v;
  }
  if (typeof base === 'string') {
    let idx;
    if (typeof key === 'number') idx = key;
    else if (typeof key === 'string') {
      const n = numericStr(key);
      if (n === null || !INT_LIKE.test(key)) {
        if (quiet) return undefined;
        const m = NUM_LEAD.exec(key);
        if (m && /^\s*[+-]?\d+/.test(key)) { warn(`Illegal string offset "${key}"`); idx = toInt(key); }
        else throwError('TypeError', `Cannot access offset of type ${typeOf(key)} on string`);
      } else idx = toInt(n);
    } else if (key === null || key === undefined) { if (quiet) return undefined; throwError('TypeError', 'Cannot access offset of type null on string'); }
    else if (typeof key === 'boolean') { idx = key ? 1 : 0; }
    else if (key instanceof Flt) { idx = floatToInt(key.v); if (!quiet) warn('String offset cast occurred'); }
    else if (typeof key === 'bigint') idx = Number(key);
    else { if (quiet) return undefined; throwError('TypeError', `Cannot access offset of type ${typeOf(key)} on string`); }
    if (idx < 0) idx += base.length;
    if (idx < 0 || idx >= base.length) { if (!quiet) warn(`Uninitialized string offset ${toStr(key)}`); return quiet ? undefined : ''; }
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
  if (!quiet) warn(`Trying to access array offset on ${typeOf(base)}`);
  return quiet ? undefined : null;
}

let strOffsetChar = null;
function strSetOffset(s, key, v) {
  let idx = typeof key === 'number' ? key : toInt(key);
  if (typeof key === 'string' && !INT_LIKE.test(key)) {
    if (/^\s*[+-]?\d/.test(key)) warn(`Illegal string offset "${key}"`);
    else throwError('TypeError', `Cannot access offset of type ${typeOf(key)} on string`);
  }
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

function writableArrIn(ref) { // ensure ref.v is a writable array (autovivify)
  let v = ref.v;
  if (v instanceof PHPArray) { if (v.cow || v.fe) { v = ref.v = v.clone(); } return v; }
  if (v === null || v === undefined) return (ref.v = new PHPArray());
  if (v === false) { deprecated('Automatic conversion of false to array is deprecated'); return (ref.v = new PHPArray()); }
  if (v instanceof PHPObject) return v;
  if (typeof v === 'string' && v === '') throwError('Error', '[] operator not supported for strings');
  throwError('Error', 'Cannot use a scalar value as an array');
}

// ---------------------------------------------------------------- lvalues
function cLval(n) {
  switch (n.k) {
    case 'Var': return typeof n.name === 'string' ? lvVar(n.name, n) : lvVarVar({ k: 'VarVar', e: n.name }, n);
    case 'VarVar': return lvVarVar(n);
    case 'Index': return lvIndex(n);
    case 'Prop': return lvProp(n);
    case 'SProp': return lvSProp(n);
    case 'List': return lvList(n);
    case 'Paren': return cLval(n.e);
  }
  return lvTemp(n);
}

function lvTemp(n) {
  const E = cExpr(n);
  const bad = () => throwError('Error', 'Cannot use temporary expression in write context');
  return {
    get: E, getq: E, set: bad, bind: bad, unset: bad,
    ref: (f) => new Ref(E(f)),
    arr: (f) => { const v = E(f); if (v instanceof PHPObject) return v; if (v instanceof PHPArray) return v.clone(); bad(); },
    modify: bad, temp: true,
  };
}

function lvVar(name, node) {
  if (name === 'this') {
    const get = (f) => { if (!f.this) throwError('Error', 'Using $this when not in object context'); return f.this; };
    const bad = () => throwError('Error', 'Cannot re-assign $this');
    return { get, getq: (f) => f.this || undefined, set: bad, bind: bad, ref: (f) => new Ref(get(f)), arr: get, unset: () => throwError('Error', 'Cannot unset $this'), modify: bad };
  }
  if (name === 'GLOBALS') {
    const get = () => globalsArray();
    const bad = () => throwError('Error', 'Cannot re-assign $GLOBALS');
    return { get, getq: get, set: bad, bind: bad, ref: (f) => new Ref(get()), arr: () => globalsProxy, unset: bad, modify: bad, globals: true };
  }
  if (SUPERGLOBALS.has(name)) {
    const R = () => rt.globals[name] || (rt.globals[name] = new Ref(new PHPArray()));
    return {
      get: () => R().v, getq: () => R().v, set: (f, v) => { R().v = v; }, bind: (f, r) => { rt.globals[name] = r; },
      ref: R, arr: () => writableArrIn(R()), unset: () => { delete rt.globals[name]; },
      modify: (f, fn) => { const r = R(); return (r.v = fn(r.v)); },
    };
  }
  return {
    name,
    get(f) { const r = f.vars[name]; if (r === undefined) { warnUndefVar(name); return null; } return r.v; },
    getq(f) { const r = f.vars[name]; return r === undefined ? undefined : r.v; },
    set(f, v) { const r = f.vars[name]; if (r !== undefined) { const old = r.v; r.v = v; if (old instanceof PHPObject && old !== v && old.cls.hasDestructor) gcCheck(old); } else f.vars[name] = new Ref(v); },
    bind(f, ref) { f.vars[name] = ref; },
    ref(f) { return f.vars[name] || (f.vars[name] = new Ref(null)); },
    arr(f) {
      const r = f.vars[name] || (f.vars[name] = new Ref(null));
      const v = r.v;
      if (v instanceof PHPArray && !v.cow && !v.fe) return v;
      return writableArrIn(r);
    },
    unset(f) { const r = f.vars[name]; delete f.vars[name]; if (r !== undefined && r.v instanceof PHPObject && r.v.cls.hasDestructor) gcCheck(r.v); },
    place() { return this; },
    modify(f, fn, quiet) {
      let r = f.vars[name];
      if (r === undefined) { if (!quiet) warnUndefVar(name); r = f.vars[name] = new Ref(null); }
      return (r.v = fn(r.v));
    },
  };
}

function lvVarVar(n) {
  const E = cExpr(n.e);
  const nm = (f) => toStr(E(f));
  const sub = (f) => lvVarDyn(nm(f));
  return {
    place: (f) => lvVarDyn(nm(f)),
    get: (f) => sub(f).get(f), getq: (f) => sub(f).getq(f), set: (f, v) => sub(f).set(f, v), bind: (f, r) => sub(f).bind(f, r),
    ref: (f) => sub(f).ref(f), arr: (f) => sub(f).arr(f), unset: (f) => sub(f).unset(f), modify: (f, fn, q) => sub(f).modify(f, fn, q),
  };
}
const lvVarCache = new Map();
function lvVarDyn(name) { let l = lvVarCache.get(name); if (!l) { l = lvVar(name); lvVarCache.set(name, l); } return l; }

// $GLOBALS support
function globalsArray() {
  const a = new PHPArray();
  for (const k of Object.keys(rt.globals)) a.set(normKey(k), cp(rt.globals[k].v));
  return a;
}
const globalsProxy = { isGlobalsProxy: true };

function lvIndex(n) {
  const P = isLvalNode(n.o) ? cLval(n.o) : lvTemp(n.o);
  const I = n.i ? cExpr(n.i) : null;
  const noIdx = () => throwError('Error', 'Cannot use [] for reading');
  if (P.globals) {
    const gref = (f) => { const k = toStr(I(f)); return rt.globals[k] || (rt.globals[k] = new Ref(null)); };
    return {
      get: (f) => { const k = toStr(I(f)); const r = rt.globals[k]; if (!r) { warn(`Undefined global variable $${k}`); return null; } return r.v; },
      getq: (f) => { const r = rt.globals[toStr(I(f))]; return r ? r.v : undefined; },
      set: (f, v) => { gref(f).v = v; }, bind: (f, r) => { rt.globals[toStr(I(f))] = r; }, ref: gref,
      arr: (f) => writableArrIn(gref(f)), unset: (f) => { delete rt.globals[toStr(I(f))]; },
      modify: (f, fn) => { const r = gref(f); return (r.v = fn(r.v)); },
    };
  }
  const lv = indexOps(P, I);
  lv.place = (f) => {
    // pre-evaluate base sub-expressions and the key (PHP evaluates dims before the assigned value)
    const bp = P.place ? P.place(f) : constPlace(P.get(f));
    const key = I ? I(f) : undefined;
    return indexOps(bp, I ? () => key : null);
  };
  return lv;
}
function constPlace(v) {
  const bad = () => throwError('Error', 'Cannot use temporary expression in write context');
  return { get: () => v, getq: () => v, set: bad, bind: bad, unset: bad, ref: () => new Ref(v), arr: () => { if (v instanceof PHPObject) return v; if (v instanceof PHPArray) return v.clone(); bad(); }, modify: bad, temp: true };
}
function indexOps(P, I) {
  const noIdx = () => throwError('Error', 'Cannot use [] for reading');
  const lv = {
    get(f) {
      const base = P.get(f);
      if (!I) noIdx();
      const key = I(f);
      if (base instanceof PHPArray) {
        const k = typeof key === 'number' ? key : normKey(key);
        const i = base.index(k);
        if (i === undefined) { warn(`Undefined array key ${keyRepr(k)}`); return null; }
        const v = base.v[i];
        return v instanceof Ref ? v.v : v;
      }
      return readIndex(base, key, false);
    },
    getq(f) {
      const base = P.getq(f);
      if (base === undefined || base === null) return undefined;
      if (!I) noIdx();
      return readIndex(base, I(f), true);
    },
    peek(f) {
      const b = P.peek ? P.peek(f) : P.getq(f);
      if (b instanceof PHPArray) return readIndex(b, I ? I(f) : null, true);
      if (typeof b === 'string') return b;
      return undefined;
    },
    set(f, v) {
      if (!P.temp) {
        const cur = P.peek ? P.peek(f) : P.getq(f);
        if (typeof cur === 'string' && cur !== '') {
          if (!I) throwError('Error', '[] operator not supported for strings');
          P.set(f, strSetOffset(cur, I(f), v));
          return strOffsetChar;
        }
      }
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        if (I) c.set(normKey(I(f)), v); else c.push(v);
        return;
      }
      if (c instanceof PHPObject) { arrayAccessSet(c, I ? I(f) : null, v); return; }
    },
    bind(f, ref) {
      const c = P.arr(f);
      if (c instanceof PHPArray) { if (I) c.setRaw(normKey(I(f)), ref); else c.push(ref); return; }
      throwError('Error', 'Cannot assign by reference to overloaded object');
    },
    ref(f) {
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        let k;
        if (I) k = normKey(I(f)); else { k = c.nextKey(); c.push(null); }
        const slot = c.getRaw(k);
        if (slot instanceof Ref) return slot;
        const r = new Ref(slot === undefined ? null : slot);
        c.setRaw(k, r);
        return r;
      }
      if (c instanceof PHPObject) {
        rt.lastRetRef = null;
        const v = arrayAccessGet(c, I ? I(f) : null);
        const rr = rt.lastRetRef; rt.lastRetRef = null;
        if (rr !== null && rr !== NOREF) return rr;
        notice(`Indirect modification of overloaded element of ${c.cls.name} has no effect`);
        return new Ref(v);
      }
      return new Ref(null);
    },
    arr(f) {
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        if (!I) { const na = new PHPArray(); c.push(na); return na; }
        const k = normKey(I(f));
        const slot = c.getRaw(k);
        let v = slot instanceof Ref ? slot.v : slot;
        if (v instanceof PHPArray) {
          if (v.cow || v.fe) { v = v.clone(); if (slot instanceof Ref) slot.v = v; else c.setRaw(k, v); }
          return v;
        }
        if (v === null || v === undefined) { const na = new PHPArray(); if (slot instanceof Ref) slot.v = na; else c.setRaw(k, na); return na; }
        if (v instanceof PHPObject) return v;
        if (v === false) { deprecated('Automatic conversion of false to array is deprecated'); const na = new PHPArray(); if (slot instanceof Ref) slot.v = na; else c.setRaw(k, na); return na; }
        if (typeof v === 'string') { if (v === '') { const na = new PHPArray(); c.setRaw(k, na); return na; } throwError('Error', 'Cannot use assign-op operators with string offsets'); }
        throwError('Error', 'Cannot use a scalar value as an array');
      }
      if (c instanceof PHPObject) {
        rt.lastRetRef = null;
        const v = arrayAccessGet(c, I ? I(f) : null);
        const rr = rt.lastRetRef; rt.lastRetRef = null;
        if (v instanceof PHPObject) return v;
        if (rr !== null && rr !== NOREF) return writableArrIn(rr);
        notice(`Indirect modification of overloaded element of ${c.cls.name} has no effect`);
        return v instanceof PHPArray ? v.clone() : new PHPArray();
      }
    },
    unset(f) {
      const cur = P.getq(f);
      if (cur === undefined || cur === null) return;
      if (cur instanceof PHPArray) { const c = P.arr(f); const k = normKey(I(f)); const old = c.get(k); c.delete(k); gcCheck(old); return; }
      if (cur instanceof PHPObject) { if (cur.cls.ancestors.has('arrayaccess')) callMethodName(cur, 'offsetUnset', [I(f)]); else throwError('Error', `Cannot use object of type ${cur.cls.name} as array`); return; }
      if (typeof cur === 'string') throwError('Error', 'Cannot unset string offsets');
    },
    modify(f, fn, quiet) {
      if (!P.temp) {
        const cur = P.getq(f);
        if (typeof cur === 'string' && cur !== '') {
          const key = I(f);
          const nv = fn(readIndex(cur, key, quiet));
          P.set(f, strSetOffset(cur, key, nv));
          return nv;
        }
      }
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        let k;
        if (I) k = normKey(I(f));
        else { const nv = fn(null); c.push(nv); return nv; }
        const i = c.index(k);
        let cur;
        if (i === undefined) { if (!quiet) warn(`Undefined array key ${keyRepr(k)}`); cur = null; }
        else { cur = c.v[i]; if (cur instanceof Ref) cur = cur.v; }
        const nv = fn(cur);
        c.set(k, nv);
        return nv;
      }
      if (c instanceof PHPObject) {
        const key = I ? I(f) : null;
        const nv = fn(quiet ? (toBool(callMethodName(c, 'offsetExists', [key])) ? arrayAccessGet(c, key) : null) : arrayAccessGet(c, key));
        arrayAccessSet(c, key, nv);
        return nv;
      }
    },
  };
  return lv;
}

function arrayAccessGet(o, k) {
  if (!o.cls.ancestors.has('arrayaccess')) throwError('Error', `Cannot use object of type ${o.cls.name} as array`);
  return callMethodName(o, 'offsetGet', [k]);
}
function arrayAccessSet(o, k, v) {
  if (!o.cls.ancestors.has('arrayaccess')) throwError('Error', `Cannot use object of type ${o.cls.name} as array`);
  callMethodName(o, 'offsetSet', [k, v]);
}

function lvProp(n) {
  const O = isLvalNode(n.o) ? cLval(n.o) : lvTemp(n.o);
  const N = typeof n.name === 'string' ? null : cExpr(n.name);
  const lv = propOps(O, N, typeof n.name === 'string' ? n.name : null, n.nullsafe);
  lv.place = (f) => {
    const op = O.place ? O.place(f) : constPlace(O.get(f));
    const name = N ? toStr(N(f)) : null;
    return propOps(op, null, N ? name : n.name, n.nullsafe);
  };
  return lv;
}
function propOps(O, N, sname, nullsafe) {
  const nm = N ? (f) => toStr(N(f)) : () => sname;
  const objW = (f, name) => {
    const o = O.get(f);
    if (o instanceof PHPObject) return o;
    if (o === null || o === undefined) throwError('Error', `Attempt to assign property "${name}" on null`);
    throwError('Error', `Attempt to assign property "${name}" on ${typeOf(o)}`);
  };
  return {
    get(f) {
      const o = O.get(f);
      if (o instanceof PHPObject) return readProp(o, nm(f), f);
      if ((o === null || o === undefined)) { if (nullsafe) return null; warn(`Attempt to read property "${nm(f)}" on null`); return null; }
      warn(`Attempt to read property "${nm(f)}" on ${typeOf(o)}`); return null;
    },
    getq(f) {
      const o = O.getq(f);
      if (o instanceof PHPObject) return readPropQuiet(o, nm(f), f);
      return undefined;
    },
    isset(f) {
      const o = O.getq(f);
      if (o instanceof PHPObject) return readPropQuiet(o, nm(f), f, true);
      return undefined;
    },
    set(f, v) { const name = nm(f); writeProp(objW(f, name), name, v, f); },
    bind(f, ref) { const name = nm(f); const o = objW(f, name); bindProp(o, name, ref, f); },
    ref(f) { const name = nm(f); return propRef(objW(f, name), name, f); },
    arr(f) {
      const name = nm(f);
      const o = O.get(f);
      if (!(o instanceof PHPObject)) {
        if (o === null || o === undefined) throwError('Error', `Attempt to modify property "${name}" on null`);
        throwError('Error', `Attempt to modify property "${name}" on ${typeOf(o)}`);
      }
      return propArr(o, name, f);
    },
    unset(f) { const o = O.getq(f); if (o instanceof PHPObject) unsetProp(o, nm(f), f); },
    modify(f, fn, quiet) {
      const name = nm(f);
      const o = objW(f, name);
      const cur = quiet ? readPropQuiet(o, name, f) : readProp(o, name, f);
      const nv = fn(cur === undefined ? null : cur);
      writeProp(o, name, nv, f);
      return nv;
    },
  };
}

function lvSProp(n) {
  const C = cClassRef(n.cls);
  const N = typeof n.name === 'string' ? null : cExpr(n.name.k === 'VarVar' ? n.name.e : n.name);
  const lv = spropOps(C, N, n.name);
  lv.place = (f) => { const cls = C(f); const name = N ? toStr(N(f)) : n.name; return spropOps(() => cls, null, name); };
  return lv;
}
function spropOps(C, N, sname) {
  const n = { name: sname };
  const nm = N ? (f) => toStr(N(f)) : () => n.name;
  const info = (f) => findStaticProp(C(f), nm(f), f);
  return {
    get: (f) => info(f).ref.v,
    getq: (f) => { const cls = C(f); const i = lookupStaticProp(cls, nm(f)); return i ? i.ref.v : undefined; },
    set: (f, v) => { const i = info(f); i.ref.v = i.type ? coercePropType(i, v, i.cls.name, nm(f)) : v; },
    bind: (f, r) => { info(f).ref = r; },
    ref: (f) => info(f).ref,
    arr: (f) => writableArrIn(info(f).ref),
    unset: () => throwError('Error', 'Attempt to unset static property'),
    modify: (f, fn) => { const i = info(f); const nv = fn(i.ref.v); i.ref.v = i.type ? coercePropType(i, nv, i.cls.name, nm(f)) : nv; return nv; },
  };
}

function lvList(n) {
  const items = n.items.map((it) => {
    if (!it) return null;
    return { K: it.key ? cExpr(it.key) : null, L: cLval(it.v), byRef: it.byRef };
  });
  const keyed = items.some((it) => it && it.K);
  const assign = (f, v, srcLv) => {
    let idx = 0;
    for (const it of items) {
      if (!it) { idx++; continue; }
      const key = it.K ? it.K(f) : idx++;
      if (it.byRef) {
        if (!srcLv) throwError('Error', 'Cannot assign reference to non referenceable value');
        const c = srcLv.arr(f);
        const k = normKey(key);
        let slot = c.getRaw(k);
        if (!(slot instanceof Ref)) { slot = new Ref(slot === undefined ? null : slot); c.setRaw(k, slot); }
        it.L.bind(f, slot);
        continue;
      }
      let val;
      if (v instanceof PHPArray) {
        const k = normKey(key);
        if (!v.has(k)) { warn(`Undefined array key ${keyRepr(k)}`); val = null; }
        else val = v.get(k);
      } else if (v instanceof PHPObject && v.cls.ancestors.has('arrayaccess')) val = callMethodName(v, 'offsetGet', [key]);
      else val = null;
      if (it.L.listAssign) it.L.listAssign(f, val, null);
      else it.L.set(f, cp(val));
    }
  };
  void keyed;
  const bad = () => throwError('Error', 'Cannot use list() in this context');
  return { listAssign: assign, set: (f, v) => assign(f, v, null), get: bad, getq: bad, ref: bad, bind: bad, arr: bad, unset: bad, modify: bad, hasRef: items.some((it) => it && it.byRef) };
}

// class reference: string name | 'self' | 'parent' | 'static' | expression
function cClassRef(c) {
  if (typeof c === 'string') {
    const lc = c.toLowerCase();
    if (lc === 'self') return (f) => { if (!f.cls) throwError('Error', 'Cannot use "self" when no class scope is active'); return f.cls; };
    if (lc === 'static') return (f) => { if (!f.sc) throwError('Error', 'Cannot use "static" when no class scope is active'); return f.sc; };
    if (lc === 'parent') return (f) => {
      if (!f.cls) throwError('Error', 'Cannot use "parent" when no class scope is active');
      if (!f.cls.parent) throwError('Error', 'Cannot use "parent" when current class scope has no parent');
      return f.cls.parent;
    };
    let cached = null;
    return () => cached || (cached = lookupClass(c));
  }
  const E = cExpr(c);
  return (f) => {
    const v = E(f);
    if (v instanceof PHPObject) return v.cls;
    if (typeof v === 'string') return lookupClass(v);
    throwError('Error', 'Cannot use value of type ' + typeOf(v) + ' as class name');
  };
}

// ---------------------------------------------------------------- expressions
function cValue(n) { // expression whose value will be stored: apply copy-on-write marking
  const E = cExpr(n);
  if (isFresh(n)) return E;
  return (f) => { const v = E(f); if (v instanceof PHPArray) v.cow = true; return v; };
}

function constValue(n) { // try to fold a literal expression; returns undefined if not constant
  if (n.k === 'Lit') return n.v;
  return undefined;
}

function cExpr(n) {
  const fn = EXPR[n.k];
  if (!fn) throw new FatalSig(`Unsupported expression type ${n.k}`, n.l);
  return fn(n);
}

const EXPR = {
  Lit(n) { const v = n.v; return () => v; },
  Paren(n) { return cExpr(n.e); },
  Temp(n) { const id = n.id; return (f) => f.temps[id]; },
  Interp(n) {
    const parts = n.parts.map((p) => (typeof p === 'string' ? p : cExpr(p)));
    if (parts.length === 2) {
      const [a, b] = parts;
      if (typeof a === 'string') return (f) => { const v = b(f); return a + (typeof v === 'string' ? v : toStr(v)); };
      if (typeof b === 'string') return (f) => { const v = a(f); return (typeof v === 'string' ? v : toStr(v)) + b; };
    }
    return (f) => {
      let s = '';
      for (let i = 0; i < parts.length; i++) { const p = parts[i]; if (typeof p === 'string') s += p; else { const v = p(f); s += typeof v === 'string' ? v : toStr(v); } }
      return s;
    };
  },
  Shell(n) {
    const S = EXPR.Interp(n);
    return (f) => { const cmd = S(f); rt.flush(); try { return fromBytes(cpMod.execSync(cmd, { stdio: ['inherit', 'pipe', 'inherit'] })); } catch (e) { return e.stdout ? fromBytes(e.stdout) : null; } };
  },
  Var(n) {
    if (typeof n.name !== 'string') return cLval(n).get;
    const name = n.name;
    if (name === 'this') return (f) => { if (!f.this) throwError('Error', 'Using $this when not in object context'); return f.this; };
    if (name === 'GLOBALS' || SUPERGLOBALS.has(name)) return cLval(n).get;
    return (f) => { const r = f.vars[name]; if (r === undefined) { warnUndefVar(name); return null; } return r.v; };
  },
  VarVar(n) { return cLval(n).get; },
  Index(n) { return cLval(n).get; },
  Prop(n) { return cLval(n).get; },
  SProp(n) { return cLval(n).get; },
  List() { throw new FatalSig('Cannot use list() outside assignment context'); },
  Arr(n) {
    const items = n.items.map((it) => {
      if (!it) throw new FatalSig('Cannot use empty array elements in arrays', n.l);
      return { K: it.key ? cExpr(it.key) : null, V: it.byRef ? null : cValue(it.v), L: it.byRef ? cLval(it.v) : null, spread: it.spread };
    });
    // constant array folding
    if (n.items.every((it) => !it.spread && !it.byRef && (!it.key || it.key.k === 'Lit') && (it.v.k === 'Lit'))) {
      const a = new PHPArray();
      for (const it of n.items) { if (it.key) a.set(normKey(it.key.v), it.v.v); else a.push(it.v.v); }
      if (a.size === 0) return () => new PHPArray();
      return () => { a.cow = true; return a; };
    }
    return (f) => {
      const a = new PHPArray();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.spread) { spreadInto(a, it.V(f)); continue; }
        if (it.L) { const r = it.L.ref(f); if (it.K) a.setRaw(normKey(it.K(f)), r); else a.push(r); continue; }
        if (it.K) { const k = it.K(f); a.set(normKey(k), it.V(f)); }
        else if (!a.push(it.V(f))) { /* overflow warning issued */ }
      }
      return a;
    };
  },
  Const(n) {
    const name = n.name, fb = n.fb;
    const lname = name.toLowerCase();
    const base = lname.startsWith('\\') ? lname.slice(1) : lname;
    if (base === 'true') return () => true;
    if (base === 'false') return () => false;
    if (base === 'null') return () => null;
    if (base === 'php_eol') return () => '\n';
    return () => {
      let v = rt.consts.get(name);
      if (v !== undefined) return v;
      if (fb) { v = rt.consts.get(fb); if (v !== undefined) return v; }
      v = rt.consts.get(lname) ?? rt.consts.get(fb ? fb.toLowerCase() : '');
      if (v !== undefined && rt.constsCI.has(lname)) return v;
      throwError('Error', `Undefined constant "${name}"`);
    };
  },
  MagicClass() { return (f) => (f.cls ? f.cls.name : ''); },
  MagicMethod(n) { const name = n.name; return (f) => (f.cls ? f.cls.name + '::' + name : name); },
  Eval(n) {
    const E = cExpr(n.e);
    const st = { ns: n.ns, uses: n.uses, useFns: n.useFns, useConsts: n.useConsts };
    return (f) => doEval(toStr(E(f)), f, st);
  },
  CConst(n) {
    const C = cClassRef(n.cls);
    const name = n.name;
    return (f) => classConst(C(f), name, f);
  },
  ClassName(n) {
    if (typeof n.cls === 'string') {
      const lc = n.cls.toLowerCase();
      if (lc !== 'self' && lc !== 'static' && lc !== 'parent') { const s = n.cls; return () => s; }
    }
    if (typeof n.cls !== 'string') {
      const E = cExpr(n.cls);
      return (f) => { const v = E(f); if (v instanceof PHPObject) return v.cls.name; throwError('TypeError', `Cannot use "::class" on ${typeOf(v)}`); };
    }
    const C = cClassRef(n.cls);
    return (f) => C(f).name;
  },
  Assign(n) {
    if (n.t.k === 'List') {
      const T = cLval(n.t);
      if (T.hasRef) {
        const S = cLval(n.e);
        return (f) => { const v = S.get(f); T.listAssign(f, v, S); return v; };
      }
      const E = cExpr(n.e);
      return (f) => { const v = E(f); T.listAssign(f, v, null); return v; };
    }
    const T = cLval(n.t);
    const E = cValue(n.e);
    if ((n.t.k === 'Index' || n.t.k === 'Prop' || n.t.k === 'SProp') && T.place && !isPureExpr(n.e) && !isSimpleTarget(n.t)) {
      return (f) => { const p = T.place(f); const v = E(f); const r = p.set(f, v); return r === undefined ? v : r; };
    }
    if (n.t.k === 'VarVar') {
      return (f) => { const p = T.place(f); const v = E(f); p.set(f, v); return v; };
    }
    if (n.t.k === 'Var' && typeof n.t.name === 'string' && n.t.name !== 'this' && n.t.name !== 'GLOBALS' && !SUPERGLOBALS.has(n.t.name)) {
      const name = n.t.name;
      return (f) => {
        const v = E(f); const r = f.vars[name];
        if (r !== undefined) { const old = r.v; r.v = v; if (old instanceof PHPObject && old !== v && old.cls.hasDestructor) gcCheck(old); }
        else f.vars[name] = new Ref(v);
        return v;
      };
    }
    if (n.t.k === 'Index') return (f) => { const v = E(f); const r = T.set(f, v); return r === undefined ? v : r; };
    return (f) => { const v = E(f); T.set(f, v); return v; };
  },
  AssignRef(n) {
    const T = cLval(n.t);
    if (!isLvalNode(n.e)) {
      const E = cExpr(n.e);
      const isCallNode = n.e.k === 'Call' || n.e.k === 'MCall' || n.e.k === 'SCall';
      return (f) => {
        rt.lastRetRef = null;
        const v = E(f);
        const r = rt.lastRetRef; rt.lastRetRef = null;
        if (r !== null && r !== NOREF && r.v === v) { T.bind(f, r); return v; }
        if (isCallNode && r !== NOREF) notice('Only variables should be assigned by reference');
        T.set(f, cp(v)); return v;
      };
    }
    const S = cLval(n.e);
    return (f) => { const r = S.ref(f); T.bind(f, r); return r.v; };
  },
  AssignOp(n) {
    const T = cLval(n.t);
    const E = cExpr(n.e);
    const op = n.op;
    if (op === '??') {
      if (T.place && !isSimpleTarget(n.t)) {
        return (f) => {
          const p = T.place(f);
          const cur = p.getq(f);
          if (cur !== undefined && cur !== null) return cur;
          const v = cp(E(f));
          p.set(f, v);
          return v;
        };
      }
      return (f) => {
        const cur = T.getq(f);
        if (cur !== undefined && cur !== null) return cur;
        const v = cp(E(f));
        T.set(f, v);
        return v;
      };
    }
    const fnop = BINOPS[op];
    if ((n.t.k === 'Index' || n.t.k === 'Prop' || n.t.k === 'SProp') && T.place && !isPureExpr(n.e) && !isSimpleTarget(n.t)) {
      return (f) => { const p = T.place(f); const v = E(f); return p.modify(f, (cur) => fnop(cur, v)); };
    }
    if (op === '.' && n.t.k === 'Var' && typeof n.t.name === 'string' && n.t.name !== 'this' && !SUPERGLOBALS.has(n.t.name) && n.t.name !== 'GLOBALS') {
      const name = n.t.name;
      return (f) => {
        const v = E(f);
        let r = f.vars[name];
        if (r === undefined) { warnUndefVar(name); r = f.vars[name] = new Ref(''); }
        const cur = r.v;
        return (r.v = (typeof cur === 'string' ? cur : toStr(cur)) + (typeof v === 'string' ? v : toStr(v)));
      };
    }
    return (f) => { const v = E(f); return T.modify(f, (cur) => fnop(cur, v)); };
  },
  PreInc(n) { const T = cLval(n.e); return (f) => T.modify(f, inc); },
  PreDec(n) { const T = cLval(n.e); return (f) => T.modify(f, dec); },
  PostInc(n) {
    if (n.e.k === 'Var' && typeof n.e.name === 'string' && n.e.name !== 'this' && !SUPERGLOBALS.has(n.e.name)) {
      const name = n.e.name;
      return (f) => {
        const r = f.vars[name];
        if (r !== undefined) { const v = r.v; if (typeof v === 'number' && v < MAXS) { r.v = v + 1; return v; } r.v = inc(v); return v; }
        warnUndefVar(name); f.vars[name] = new Ref(1); return null;
      };
    }
    const T = cLval(n.e);
    return (f) => { let old; T.modify(f, (c) => { old = c; return inc(c); }); return old; };
  },
  PostDec(n) {
    const T = cLval(n.e);
    return (f) => { let old; T.modify(f, (c) => { old = c; return dec(c); }); return old; };
  },
  Bin(n) {
    const op = n.op;
    const A = cExpr(n.a), B = cExpr(n.b);
    if (n.a.k === 'Var' && typeof n.a.name === 'string' && n.a.name !== 'this' && !isPureExpr(n.b)) {
      // PHP reads compiled-variable operands when the operator executes, i.e. after the right operand
      const fnop = BINOPS[op];
      return (f) => { const b = B(f); return fnop(A(f), b); };
    }
    // constant folding for pure literal operands
    if (n.a.k === 'Lit' && n.b.k === 'Lit' && ['.', '+', '-', '*', '|', '&', '<<', '>>'].includes(op) && (isNum(n.a.v) || typeof n.a.v === 'string') && (isNum(n.b.v) || typeof n.b.v === 'string')) {
      if (op === '.' || (isNum(n.a.v) && isNum(n.b.v))) { const v = BINOPS[op](n.a.v, n.b.v); return () => v; }
    }
    switch (op) {
      case '+': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAXS && r >= -MAXS) return r; } return add(a, b); };
      case '-': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAXS && r >= -MAXS) return r; } return sub(a, b); };
      case '*': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAXS && r >= -MAXS) return r === 0 ? 0 : r; } return mul(a, b); };
      case '.': return (f) => { const a = A(f), b = B(f); return (typeof a === 'string' ? a : toStr(a)) + (typeof b === 'string' ? b : toStr(b)); };
      case '<': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a < b; return lt(a, b); };
      case '>': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a > b; return lt(b, a); };
      case '<=': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a <= b; return le(a, b); };
      case '>=': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a >= b; return le(b, a); };
      case '==': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a === b; return looseEq(a, b); };
      case '!=': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a !== b; return !looseEq(a, b); };
      case '===': return (f) => { const a = A(f), b = B(f); if (a === b && !(a instanceof Flt)) return true; return strictEq(a, b); };
      case '!==': return (f) => { const a = A(f), b = B(f); if (a === b && !(a instanceof Flt)) return false; return !strictEq(a, b); };
    }
    const fnop = BINOPS[op];
    if (!fnop) throw new FatalSig(`Unknown operator ${op}`, n.l);
    return (f) => { const a = A(f); return fnop(a, B(f)); };
  },
  And(n) { const A = cExpr(n.a), B = cExpr(n.b); return (f) => toBool(A(f)) && toBool(B(f)); },
  Or(n) { const A = cExpr(n.a), B = cExpr(n.b); return (f) => toBool(A(f)) || toBool(B(f)); },
  Xor(n) { const A = cExpr(n.a), B = cExpr(n.b); return (f) => toBool(A(f)) !== toBool(B(f)); },
  Not(n) { const A = cExpr(n.e); return (f) => !toBool(A(f)); },
  Neg(n) { const A = cExpr(n.e); return (f) => { const v = A(f); if (typeof v === 'number') return v === 0 ? 0 : -v; if (v instanceof Flt) return mkf(-v.v); return mul(v, -1); }; },
  Plus(n) { const A = cExpr(n.e); return (f) => { const v = A(f); if (isNum(v)) return v; return mul(v, 1); }; },
  BitNot(n) { const A = cExpr(n.e); return (f) => bitNot(A(f)); },
  Silence(n) {
    const A = cExpr(n.e);
    return (f) => { rt.silence++; try { return A(f); } finally { rt.silence--; } };
  },
  Coalesce(n) {
    const A = isLvalNode(n.a) ? cLval(n.a).getq : cExpr(n.a);
    const B = cExpr(n.b);
    return (f) => { const v = A(f); return v === undefined || v === null ? B(f) : v; };
  },
  Ternary(n) {
    const C = cExpr(n.c), B = cExpr(n.b);
    if (!n.a) return (f) => { const v = C(f); return toBool(v) ? v : B(f); };
    const A = cExpr(n.a);
    return (f) => (toBool(C(f)) ? A(f) : B(f));
  },
  Cast(n) {
    const A = cExpr(n.e);
    switch (n.t) {
      case 'int': return (f) => toInt(A(f));
      case 'float': return (f) => mkf(toDbl(A(f)));
      case 'string': return (f) => toStr(A(f));
      case 'bool': return (f) => toBool(A(f));
      case 'array': return (f) => toArrayCast(A(f));
      case 'object': return (f) => toObjectCast(A(f));
      case 'unset': return (f) => { A(f); return null; };
    }
  },
  Isset(n) {
    const items = n.list.map((e) => (isLvalNode(e) ? (() => { const lv = cLval(e); return lv.isset || lv.getq; })() : (() => { throw new FatalSig('Cannot use isset() on the result of an expression (you can use "null !== expression" instead)', n.l); })()));
    return (f) => { for (let i = 0; i < items.length; i++) { const v = items[i](f); if (v === undefined || v === null) return false; } return true; };
  },
  Empty(n) {
    const A = isLvalNode(n.e) ? cLval(n.e).getq : cExpr(n.e);
    return (f) => { const v = A(f); return v === undefined || !toBool(v); };
  },
  Instanceof(n) {
    const E = cExpr(n.e);
    if (typeof n.cls === 'string') {
      const lc = n.cls.toLowerCase();
      if (lc === 'self' || lc === 'static' || lc === 'parent') {
        const C = cClassRef(n.cls);
        return (f) => { const v = E(f); return v instanceof PHPObject && v.cls.ancestors.has(C(f).lname); };
      }
      return (f) => { const v = E(f); return v instanceof PHPObject && v.cls.ancestors.has(lc); };
    }
    const C = cExpr(n.cls);
    return (f) => {
      const v = E(f), c = C(f);
      if (!(v instanceof PHPObject)) return false;
      if (c instanceof PHPObject) return v.cls.ancestors.has(c.cls.lname);
      if (typeof c === 'string') return v.cls.ancestors.has((c[0] === '\\' ? c.slice(1) : c).toLowerCase());
      throwError('Error', 'Class name must be a valid object or a string');
    };
  },
  Clone(n) {
    const E = cExpr(n.e);
    return (f) => cloneObject(E(f), f);
  },
  Print(n) { const E = cExpr(n.e); return (f) => { rt.echo(toStr(E(f))); return 1; }; },
  Exit(n) {
    const E = n.e ? cExpr(n.e) : null;
    return (f) => {
      const v = E ? E(f) : null;
      if (typeof v === 'string') { rt.echo(v); throw new ExitSig(0); }
      throw new ExitSig(v === null ? 0 : toInt(v));
    };
  },
  Throw(n) {
    const E = cExpr(n.e);
    return (f) => {
      const v = E(f);
      if (!(v instanceof PHPObject) || !v.cls.ancestors.has('throwable')) throwError('Error', 'Can only throw objects');
      throw new ThrowSig(v);
    };
  },
  Include(n) {
    const E = cExpr(n.e);
    const kind = n.kind;
    return (f) => doInclude(toStr(E(f)), kind, f);
  },
  Yield() { return () => { throw new FatalSig('Internal error: yield outside generator context'); }; },
  YieldFrom() { return () => { throw new FatalSig('Internal error: yield outside generator context'); }; },
  Match(n) {
    const E = cExpr(n.e);
    const arms = n.arms.map((a) => ({ conds: a.conds ? a.conds.map(cExpr) : null, body: cExpr(a.body) }));
    return (f) => {
      const v = E(f);
      let def = null;
      for (const arm of arms) {
        if (!arm.conds) { def = arm; continue; }
        for (const c of arm.conds) if (strictEq(v, c(f))) return arm.body(f);
      }
      if (def) return def.body(f);
      throwError('UnhandledMatchError', `Unhandled match case ${matchRepr(v)}`);
    };
  },
  Closure(n) {
    const fnObj = compileFunction(n.fn);
    if (n.fn.arrow) {
      const free = arrowFreeVars(n.fn);
      return (f) => {
        const bound = new Map();
        for (const name of free) { const r = f.vars[name]; if (r !== undefined) bound.set(name, cp(r.v)); }
        return makeClosure(fnObj, bound, n.fn.static ? null : f.this, f.cls, f.sc);
      };
    }
    const uses = n.fn.uses || [];
    return (f) => {
      const bound = new Map();
      for (const u of uses) {
        if (u.byRef) bound.set(u.name, f.vars[u.name] || (f.vars[u.name] = new Ref(null)));
        else { const r = f.vars[u.name]; if (r === undefined) { warnUndefVar(u.name); bound.set(u.name, null); } else bound.set(u.name, cp(r.v)); }
      }
      return makeClosure(fnObj, bound, n.fn.static ? null : f.this, f.cls, f.sc);
    };
  },
  New(n) {
    const A = n.args === 'fcc' ? null : compileArgs(n.args);
    if (n.cls && typeof n.cls === 'object' && n.cls.k === 'ClassDecl') {
      const decl = n.cls;
      let cls = null;
      return (f) => {
        if (!cls) cls = declareClass(decl, f);
        return instantiate(cls, A, f);
      };
    }
    const C = cClassRef(n.cls);
    return (f) => instantiate(C(f), A, f);
  },
  Call(n) {
    if (typeof n.f === 'string') return compileNamedCall(n);
    const F = cExpr(n.f);
    if (n.args === 'fcc') return (f) => callableToClosure(F(f), f);
    const A = compileArgs(n.args);
    return (f) => {
      const callee = F(f);
      const c = resolveCallable(callee, f, true);
      const args = A(f, c.fn);
      return invokeCallable(c, args);
    };
  },
  MCall(n) {
    const O = cExpr(n.o);
    const N = typeof n.name === 'string' ? null : cExpr(n.name);
    const sname = typeof n.name === 'string' ? n.name : null;
    const lname = sname ? sname.toLowerCase() : null;
    const nullsafe = n.nullsafe;
    if (n.args === 'fcc') {
      return (f) => {
        const o = O(f);
        const name = sname || toStr(N(f));
        if (!(o instanceof PHPObject)) throwError('Error', `Call to a member function ${name}() on ${typeOf(o)}`);
        return methodClosure(o, name, f);
      };
    }
    const A = compileArgs(n.args);
    return (f) => {
      const o = O(f);
      if (!(o instanceof PHPObject)) {
        if (nullsafe && (o === null || o === undefined)) return null;
        let name = sname;
        if (!name) { const nv = N(f); name = typeof nv === 'string' ? nv : '{closure}'; }
        throwError('Error', `Call to a member function ${name}() on ${typeOf(o)}`);
      }
      let name = sname, ln = lname;
      if (!name) {
        const nv = N(f);
        if (nv instanceof PHPObject) { const c = resolveCallable(nv, f, true); return invokeCallable(c, A(f, c.fn)); }
        name = toStr(nv); ln = name.toLowerCase();
      }
      let m;
      const scope = f.cls;
      if (scope !== null && scope.privMethods !== null) { const pm = scope.privMethods.get(ln); if (pm !== undefined && o.cls.ancestors.has(scope.lname)) m = pm; }
      if (m === undefined) m = o.cls.methods.get(ln);
      if (m !== undefined && (m.vis === 'public' || canAccessMember(m, f.cls))) {
        const args = A(f, m.fn);
        if (m.static) return callFunction(m.fn, args, null, m.cls, o.cls, null);
        return callFunction(m.fn, args, o, m.cls, o.cls, null);
      }
      // closure stored in property is not a method; __call fallback
      if (o.cls === closureClass && (ln === 'call' || ln === '__invoke' || ln === 'bindto' || ln === 'bind')) {
        const cm = o.cls.methods.get(ln);
        return callFunction(cm.fn, A(f, cm.fn), o, o.cls, o.cls, null);
      }
      const magic = o.cls.methods.get('__call');
      if (magic) {
        const args = A(f, null);
        return callFunction(magic.fn, [name, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], o, magic.cls, o.cls, null);
      }
      if (m !== undefined) throwError('Error', `Call to ${m.vis} method ${o.cls.name}::${m.name}() from ${f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
      throwError('Error', `Call to undefined method ${o.cls.name}::${name}()`);
    };
  },
  SCall(n) {
    const C = cClassRef(n.cls);
    const N = typeof n.name === 'string' ? null : cExpr(n.name);
    const sname = typeof n.name === 'string' ? n.name : null;
    const isRel = typeof n.cls === 'string' && ['self', 'parent', 'static'].includes(n.cls.toLowerCase());
    const isParent = typeof n.cls === 'string' && n.cls.toLowerCase() === 'parent';
    const isSelf = typeof n.cls === 'string' && n.cls.toLowerCase() === 'self';
    if (n.args === 'fcc') {
      return (f) => {
        const cls = C(f);
        const name = sname || toStr(N(f));
        const m = findMethod(cls, name);
        if (!m) throwError('Error', `Call to undefined method ${cls.name}::${name}()`);
        const thisObj = !m.static && f.this && f.this.cls.ancestors.has(cls.lname) ? f.this : null;
        return makeClosure(m.fn, null, thisObj, m.cls, (isRel && !isParent && !isSelf) ? cls : (thisObj ? thisObj.cls : (isRel ? f.sc : cls)), null);
      };
    }
    const A = compileArgs(n.args);
    return (f) => {
      const cls = C(f);
      const name = sname || toStr(N(f));
      const m = cls.methods.get(name.toLowerCase());
      if (!m || (m.vis !== 'public' && !canAccessMember(m, f.cls))) {
        // __callStatic / __call
        if (f.this && f.this.cls.ancestors.has(cls.lname)) {
          const mc = cls.methods.get('__call');
          if (mc) { const args = A(f, null); return callFunction(mc.fn, [name, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], f.this, mc.cls, f.this.cls, null); }
        }
        const ms = cls.methods.get('__callstatic');
        if (ms) { const args = A(f, null); return callFunction(ms.fn, [name, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], null, ms.cls, cls, null); }
        if (m) throwError('Error', `Call to ${m.vis} method ${cls.name}::${m.name}() from ${f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
        throwError('Error', `Call to undefined method ${cls.name}::${name}()`);
      }
      if (m.abstract) throwError('Error', `Cannot call abstract method ${m.cls.name}::${m.name}()`);
      const args = A(f, m.fn);
      if (m.static) {
        const sc = isRel && (isParent || isSelf) ? (f.sc || cls) : cls;
        return callFunction(m.fn, args, null, m.cls, sc, null);
      }
      if (f.this && f.this.cls.ancestors.has(cls.lname)) return callFunction(m.fn, args, f.this, m.cls, f.this.cls, null);
      throwError('Error', `Non-static method ${cls.name}::${m.name}() cannot be called statically`);
    };
  },
};

// target whose sub-expressions are literals / plain variables that the RHS cannot change
function isSimpleTarget(t) {
  switch (t.k) {
    case 'Var': return typeof t.name === 'string';
    case 'Index': return isSimpleTarget(t.o) && (t.i === null || t.i.k === 'Lit');
    case 'Prop': return isSimpleTarget(t.o) && typeof t.name === 'string';
    case 'SProp': return typeof t.cls === 'string' && typeof t.name === 'string';
  }
  return false;
}
function isPureExpr(n) {
  if (!n || typeof n !== 'object') return true;
  switch (n.k) {
    case 'Lit': case 'Var': case 'Const': case 'CConst': case 'ClassName': case 'MagicClass': return true;
    case 'Bin': return isPureExpr(n.a) && isPureExpr(n.b);
    case 'Not': case 'Neg': case 'Plus': case 'BitNot': case 'Cast': return isPureExpr(n.e);
    case 'Interp': return n.parts.every((p) => typeof p === 'string' || isPureExpr(p));
    case 'Index': return isPureExpr(n.o) && (n.i === null || isPureExpr(n.i));
    case 'Arr': return n.items.every((it) => !it || (isPureExpr(it.v) && (!it.key || isPureExpr(it.key))));
    case 'Ternary': return isPureExpr(n.c) && (!n.a || isPureExpr(n.a)) && isPureExpr(n.b);
    case 'And': case 'Or': case 'Xor': case 'Coalesce': return isPureExpr(n.a) && isPureExpr(n.b);
    case 'Isset': return n.list.every(isPureExpr);
    case 'Empty': return isPureExpr(n.e);
  }
  return false;
}
function matchRepr(v) {
  if (typeof v === 'string') { const max = 15; return "'" + (v.length > max ? v.slice(0, max) + '...' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
  if (v instanceof PHPObject) return 'of type ' + v.cls.name;
  if (v instanceof PHPArray) return 'of type array';
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Flt) return fmtReprZ(v.v);
  return toStr(v);
}

function lt(a, b) {
  if (a instanceof Flt && b instanceof Flt) return a.v < b.v;
  if (a instanceof Flt && typeof b === 'number') return a.v < b;
  if (typeof a === 'number' && b instanceof Flt) return a < b.v;
  if ((a instanceof Flt && a.v !== a.v) || (b instanceof Flt && b.v !== b.v)) return false;
  return cmp(a, b) < 0;
}
function le(a, b) {
  if (a instanceof Flt && b instanceof Flt) return a.v <= b.v;
  if (a instanceof Flt && typeof b === 'number') return a.v <= b;
  if (typeof a === 'number' && b instanceof Flt) return a <= b.v;
  if ((a instanceof Flt && a.v !== a.v) || (b instanceof Flt && b.v !== b.v)) return false;
  return cmp(a, b) <= 0;
}

const BINOPS = {
  '+': add, '-': sub, '*': mul, '/': div, '%': mod, '**': pow, '.': concat,
  '&': bitAnd, '|': bitOr, '^': bitXor, '<<': shl, '>>': shr,
  '==': looseEq, '!=': (a, b) => !looseEq(a, b), '===': strictEq, '!==': (a, b) => !strictEq(a, b),
  '<': lt, '>': (a, b) => lt(b, a), '<=': le, '>=': (a, b) => le(b, a), '<=>': cmp,
};

function spreadInto(a, v) {
  if (v instanceof PHPArray) {
    for (const [k, x] of v.entries()) { if (typeof k === 'string') a.set(k, cp(x)); else a.push(cp(x)); }
    return;
  }
  if (v instanceof PHPObject && v.cls.ancestors.has('traversable')) {
    iterateObject(v, (k, x) => { if (typeof k === 'string') a.set(k, cp(x)); else a.push(cp(x)); });
    return;
  }
  throwError('Error', 'Only arrays and Traversables can be unpacked');
}

// ---------------------------------------------------------------- arguments
function isRefParam(fn, i) {
  if (!fn) return false;
  const r = fn.refs;
  if (r === null || r === undefined) return false;
  if (i < r.length) return r[i];
  return fn.refRest !== undefined && fn.refRest !== null && i >= fn.refRest;
}
function compileArgs(argNodes) {
  if (argNodes.length === 0) return () => [];
  const items = argNodes.map((a) => ({
    E: cExpr(a.e), L: isLvalNode(a.e) ? cLval(a.e) : null, spread: !!a.spread, name: a.name || null,
    tempRef: !isLvalNode(a.e) && ['Call', 'MCall', 'SCall', 'New', 'Include', 'Eval'].includes(a.e.k),
  }));
  const simple = items.every((it) => !it.spread && !it.name);
  if (simple) {
    const n = items.length;
    return (f, fn) => {
      const out = new Array(n);
      const refs = fn ? fn.refs : null;
      for (let i = 0; i < n; i++) {
        const it = items[i];
        if (refs && isRefParam(fn, i)) {
          if (it.L) out[i] = it.L.ref(f);
          else {
            rt.lastRetRef = null;
            const v = it.E(f);
            const rr = rt.lastRetRef; rt.lastRetRef = null;
            if (rr !== null && rr !== NOREF && rr.v === v) { out[i] = rr; continue; }
            if (rr === NOREF) { out[i] = new Ref(v); continue; }
            if (!it.tempRef) { const pn = fn.params ? (fn.params[i] && fn.params[i].name) : (fn.pnames && fn.pnames[i]); throwError('Error', `${fnDisplayName(fn)}(): Argument #${i + 1}${pn ? ' ($' + pn + ')' : ''} could not be passed by reference`); }
            notice('Only variables should be passed by reference');
            out[i] = new Ref(v);
          }
        } else out[i] = it.E(f);
      }
      return out;
    };
  }
  return (f, fn) => {
    const out = [];
    let named = null;
    for (const it of items) {
      if (it.spread) {
        let v = it.E(f);
        if (v instanceof PHPArray && it.L && fn && fn.refs) {
          // unpacking into by-reference parameters binds the array elements
          const arr = it.L.arr(f);
          for (let i = 0; i < arr.k.length; i++) {
            const k = arr.k[i]; if (k === undefined) continue;
            if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, deref(arr.v[i])); continue; }
            if (isRefParam(fn, out.length)) { let slot = arr.v[i]; if (!(slot instanceof Ref)) { slot = new Ref(slot); arr.v[i] = slot; } out.push(slot); }
            else out.push(deref(arr.v[i]));
          }
          continue;
        }
        if (v instanceof PHPArray) {
          for (const [k, x] of v.entries()) {
            if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, x); }
            else { if (named) throwError('Error', 'Cannot use positional argument after named argument during unpacking'); out.push(x); }
          }
        } else if (v instanceof PHPObject && v.cls.ancestors.has('traversable')) {
          iterateObject(v, (k, x) => {
            if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, x); }
            else if (isInt(k)) { if (named) throwError('Error', 'Cannot use positional argument after named argument during unpacking'); out.push(x); }
            else throwError('Error', 'Keys must be of type int|string during argument unpacking');
          });
        } else throwError('Error', 'Only arrays and Traversables can be unpacked');
        continue;
      }
      if (it.name) {
        if (!named) named = new Map();
        if (named.has(it.name)) throwError('Error', `Named parameter $${it.name} overwrites previous argument`);
        let pi = -1;
        if (fn && fn.params) pi = fn.params.findIndex((p) => p.name === it.name);
        if (pi >= 0 && isRefParam(fn, pi) && it.L) named.set(it.name, it.L.ref(f));
        else named.set(it.name, it.E(f));
        continue;
      }
      if (named) throwError('Error', 'Cannot use positional argument after named argument');
      const i = out.length;
      if (isRefParam(fn, i)) out.push(it.L ? it.L.ref(f) : new Ref(it.E(f)));
      else out.push(it.E(f));
    }
    if (named) out.named = named;
    return out;
  };
}

function compileNamedCall(n) {
  const name = n.f, fb = n.fb;
  const lname = name.toLowerCase(), lfb = fb ? fb.toLowerCase() : null;
  // compile-time special forms that need the caller's frame
  const special = FRAME_FUNCS[lfb || lname];
  if (special) {
    const A = n.args === 'fcc' ? null : compileArgs(n.args);
    return (f) => special(f, A ? A(f, null) : []);
  }
  if (n.args === 'fcc') {
    return (f) => {
      const fn = rt.fns.get(lname) || (lfb && rt.fns.get(lfb));
      if (!fn) throwError('Error', `Call to undefined function ${name}()`);
      return makeClosure(fn, null, null, null, null);
    };
  }
  const A = compileArgs(n.args);
  let cached = null;
  return (f) => {
    let fn = cached;
    if (fn === null) {
      fn = rt.fns.get(lname);
      if (fn === undefined && lfb) fn = rt.fns.get(lfb);
      if (fn === undefined) fn = lazyFn(lfb || lname);
      if (fn === undefined) { const sp = FRAME_FUNCS[lfb || lname]; if (sp) return sp(f, A(f, null)); throwError('Error', `Call to undefined function ${fb || name}()`); }
      cached = fn;
    }
    const args = A(f, fn);
    if (fn.native) return callNative(fn, args);
    return callFunction(fn, args, null, null, null, null);
  };
}

// ---------------------------------------------------------------- statements
function cStmts(list) {
  const fns = [];
  for (const s of list) { const c = cStmt(s); if (c) fns.push(c); }
  const n = fns.length;
  if (n === 0) return () => undefined;
  if (n === 1) return fns[0];
  if (n === 2) { const [a, b] = fns; return (f) => { const r = a(f); if (r !== undefined) return r; return b(f); }; }
  return (f) => {
    for (let i = 0; i < n; i++) { const r = fns[i](f); if (r !== undefined) return r; }
    return undefined;
  };
}
function cBody(n) { return n.k === 'Block' ? cStmts(n.body) : cStmts([n]); }

function cStmt(n) {
  if (!n) return null;
  const fn = STMT[n.k];
  if (!fn) throw new FatalSig(`Unsupported statement type ${n.k}`, n.l);
  return fn(n);
}

const STMT = {
  Block(n) { return cStmts(n.body); },
  Echo(n) {
    const l = n.l;
    if (n.args.length === 1 && n.args[0].k === 'Lit') { const s = toStr(n.args[0].v); return () => { rt.echo(s); }; }
    const args = n.args.map(cExpr);
    if (args.length === 1) { const A = args[0]; return (f) => { rt.line = l; const v = A(f); rt.echo(typeof v === 'string' ? v : toStr(v)); }; }
    return (f) => { rt.line = l; for (let i = 0; i < args.length; i++) { const v = args[i](f); rt.echo(typeof v === 'string' ? v : toStr(v)); } };
  },
  ExprStmt(n) {
    const E = cExpr(n.e); const l = n.l;
    if (n.e.k === 'Assign' || n.e.k === 'AssignOp' || n.e.k === 'PreInc' || n.e.k === 'PostInc' || n.e.k === 'AssignRef') return (f) => { rt.line = l; E(f); };
    return (f) => { rt.line = l; const v = E(f); if (v instanceof PHPObject && v.cls.hasDestructor && !v.destructed) gcCheck(v); };
  },
  If(n) {
    const conds = [cExpr(n.c), ...n.elifs.map((e) => cExpr(e.c))];
    const bodies = [cBody(n.then), ...n.elifs.map((e) => cBody(e.body))];
    const els = n.els ? cBody(n.els) : null;
    const l = n.l;
    if (conds.length === 1) {
      const C = conds[0], T = bodies[0];
      if (els) return (f) => { rt.line = l; return toBool(C(f)) ? T(f) : els(f); };
      return (f) => { rt.line = l; if (toBool(C(f))) return T(f); };
    }
    return (f) => {
      rt.line = l;
      for (let i = 0; i < conds.length; i++) if (toBool(conds[i](f))) return bodies[i](f);
      if (els) return els(f);
    };
  },
  While(n) {
    const C = cExpr(n.c), B = cBody(n.body), l = n.l;
    return (f) => {
      rt.line = l;
      while (toBool(C(f))) {
        const r = B(f);
        if (r !== undefined) {
          if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
          if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
          return r;
        }
      }
    };
  },
  DoWhile(n) {
    const C = cExpr(n.c), B = cBody(n.body);
    return (f) => {
      do {
        const r = B(f);
        if (r !== undefined) {
          if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
          if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
          return r;
        }
      } while (toBool(C(f)));
    };
  },
  For(n) {
    const init = n.init.map(cExpr), cond = n.cond.map(cExpr), step = n.step.map(cExpr), B = cBody(n.body), l = n.l;
    return (f) => {
      rt.line = l;
      for (const e of init) e(f);
      for (;;) {
        let ok = true;
        for (let i = 0; i < cond.length; i++) { const v = cond[i](f); if (i === cond.length - 1) ok = toBool(v); }
        if (!ok) break;
        const r = B(f);
        if (r !== undefined) {
          if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
          if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); }
          else return r;
        }
        for (let i = 0; i < step.length; i++) step[i](f);
      }
    };
  },
  Foreach(n) {
    const E = cExpr(n.e);
    const LE = n.byRef ? cLval(n.e) : null;
    const K = n.kv ? cLval(n.kv) : null;
    const V = cLval(n.v);
    const isList = n.v.k === 'List';
    const B = cBody(n.body), l = n.l;
    const simpleVar = n.v.k === 'Var' && typeof n.v.name === 'string' && n.v.name !== 'this' && !SUPERGLOBALS.has(n.v.name) ? n.v.name : null;
    const handle = (r) => r; // eslint helper
    void handle;
    return (f) => {
      rt.line = l;
      if (n.byRef) {
        const subj0 = LE.getq(f);
        if (subj0 instanceof PHPObject) return foreachObject(f, subj0, K, V, B, true, isList);
        if (subj0 !== undefined && subj0 !== null && !(subj0 instanceof PHPArray)) { warn(`foreach() argument must be of type array|object, ${valueName(subj0)} given`); return; }
        const arr = LE.arr(f);
        if (!(arr instanceof PHPArray)) return foreachObject(f, arr, K, V, B, true, isList);
        arr.iters++;
        try {
          for (let i = 0; i < arr.k.length; i++) {
            const key = arr.k[i];
            if (key === undefined) continue;
            let slot = arr.v[i];
            if (!(slot instanceof Ref)) { slot = new Ref(slot); arr.v[i] = slot; }
            V.bind(f, slot);
            if (K) K.set(f, key);
            const r = B(f);
            if (r !== undefined) {
              if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
              if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
              return r;
            }
          }
        } finally { arr.iters--; }
        return;
      }
      const subj = E(f);
      if (subj instanceof PHPArray) {
        if (subj.size === 0) return;
        subj.fe = (subj.fe || 0) + 1;
        try {
          const ks = subj.k, vs = subj.v;
          for (let i = 0; i < ks.length; i++) {
            const key = ks[i];
            if (key === undefined) continue;
            let v = vs[i];
            if (v instanceof Ref) v = v.v;
            if (v instanceof PHPArray) v.cow = true;
            if (simpleVar !== null) { const r = f.vars[simpleVar]; if (r !== undefined) r.v = v; else f.vars[simpleVar] = new Ref(v); }
            else if (isList) V.listAssign(f, v, null);
            else V.set(f, v);
            if (K) K.set(f, key);
            const r = B(f);
            if (r !== undefined) {
              if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
              if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
              return r;
            }
          }
        } finally { subj.fe--; }
        return;
      }
      if (subj instanceof PHPObject) return foreachObject(f, subj, K, V, B, false, isList);
      warn(`foreach() argument must be of type array|object, ${valueName(subj)} given`);
    };
  },
  Switch(n) {
    const E = cExpr(n.e);
    const flat = [];
    const starts = [];
    let defIdx = -1;
    for (const c of n.cases) {
      starts.push({ T: c.test ? cExpr(c.test) : null, at: flat.length });
      if (!c.test) defIdx = starts.length - 1;
      for (const s of c.body) { const cs = cStmt(s); if (cs) flat.push(cs); }
    }
    const l = n.l;
    return (f) => {
      rt.line = l;
      const v = E(f);
      let start = -1;
      for (let i = 0; i < starts.length; i++) { const s = starts[i]; if (s.T && looseEq(v, s.T(f))) { start = s.at; break; } }
      if (start < 0) { if (defIdx < 0) return; start = starts[defIdx].at; }
      for (let i = start; i < flat.length; i++) {
        const r = flat[i](f);
        if (r !== undefined) {
          if (r.t === 1 || r.t === 2) { if (r.n > 1) return r.t === 1 ? mkBreak(r.n - 1) : mkCont(r.n - 1); return; }
          return r;
        }
      }
    };
  },
  Break(n) { const r = mkBreak(n.n); return () => r; },
  Continue(n) { const r = mkCont(n.n); return () => r; },
  Return(n) {
    if (!n.e) return (f) => { f.ret = null; return RETURN; };
    if (compilingByRef && isLvalNode(n.e)) {
      const L = cLval(n.e); const l = n.l;
      return (f) => { rt.line = l; const r = L.ref(f); f.ret = r.v; f.retRef = r; return RETURN; };
    }
    if (compilingByRef && n.e.k !== 'Call' && n.e.k !== 'MCall' && n.e.k !== 'SCall' && n.e.k !== 'New') {
      const E0 = cValue(n.e); const l = n.l;
      return (f) => { rt.line = l; f.ret = E0(f); notice('Only variable references should be returned by reference'); return RETURN; };
    }
    if (compilingByRef) {
      const E0 = cValue(n.e); const l = n.l;
      return (f) => { rt.line = l; rt.lastRetRef = null; const v = E0(f); const r = rt.lastRetRef; rt.lastRetRef = null; f.ret = v; if (r !== null && r !== NOREF && r.v === v) f.retRef = r; else if (r !== NOREF) notice('Only variable references should be returned by reference'); return RETURN; };
    }
    const E = cValue(n.e); const l = n.l;
    return (f) => { rt.line = l; f.ret = E(f); return RETURN; };
  },
  Try(n) {
    const B = cBody(n.body);
    const catches = n.catches.map((c) => ({ types: c.types.map((t) => t.toLowerCase()), v: c.v, B: cBody(c.body) }));
    const F = n.fin ? cBody(n.fin) : null;
    return (f) => {
      let res;
      try {
        res = B(f);
      } catch (e) {
        const sig = toThrowSig(e);
        if (!sig) throw e;
        const obj = sig.obj;
        let handled = false;
        for (const c of catches) {
          if (c.types.some((t) => obj.cls.ancestors.has(t))) {
            if (c.v) { const r = f.vars[c.v]; if (r) r.v = obj; else f.vars[c.v] = new Ref(obj); }
            handled = true;
            if (F) {
              try { res = c.B(f); }
              finally { const fr = F(f); if (fr !== undefined) return fr; } // eslint-disable-line no-unsafe-finally
              return res;
            }
            return c.B(f);
          }
        }
        if (!handled) {
          if (F) { const fr = F(f); if (fr !== undefined) return fr; }
          throw sig;
        }
      }
      if (F) { const fr = F(f); if (fr !== undefined) return fr; }
      return res;
    };
  },
  Global(n) {
    const names = n.names.map((x) => (typeof x === 'string' ? x : cExpr(x.e)));
    return (f) => {
      for (const x of names) {
        const name = typeof x === 'string' ? x : toStr(x(f));
        f.vars[name] = rt.globals[name] || (rt.globals[name] = new Ref(null));
      }
    };
  },
  StaticVar(n) {
    const vars = n.vars.map((v) => ({ name: v.name, init: v.init ? cExpr(v.init) : null }));
    return (f) => {
      let st = f.statics;
      if (!st) {
        const owner = f.closure || f.fn;
        if (!owner) { st = rt.mainStatics || (rt.mainStatics = new Map()); }
        else {
          if (!owner.statics) owner.statics = new Map();
          st = owner.statics;
          // methods: statics are per-class (late static binding scope)
          if (f.fn && f.fn.isMethod && f.sc && !f.closure) {
            let m = owner.staticsByClass; if (!m) m = owner.staticsByClass = new Map();
            st = m.get(f.sc); if (!st) { st = new Map(); m.set(f.sc, st); }
          }
        }
        f.statics = st;
      }
      for (const v of vars) {
        let r = st.get(v.name);
        if (!r) { r = new Ref(v.init ? cp(v.init(f)) : null); st.set(v.name, r); }
        f.vars[v.name] = r;
      }
    };
  },
  Unset(n) {
    const ls = n.list.map(cLval);
    return (f) => { for (const lv of ls) lv.unset(f); };
  },
  ConstDecl(n) {
    const items = n.items.map((i) => ({ name: i.name, E: cExpr(i.e) }));
    return (f) => {
      for (const it of items) {
        if (rt.consts.has(it.name)) { warn(`Constant ${it.name} already defined`); continue; }
        rt.consts.set(it.name, it.E(f));
      }
    };
  },
  FuncDecl(n) {
    if (n.hoisted) return null;
    const decl = n.fn;
    return () => { declareFunction(decl); };
  },
  ClassDecl(n) {
    return (f) => { if (!n.declared) declareClass(n, f); };
  },
};

// ---------------------------------------------------------------- foreach over objects
function foreachObject(f, obj, K, V, B, byRef, isList) {
  const assignV = (v) => { if (isList) V.listAssign(f, v, null); else V.set(f, cp(v)); };
  const run = () => { const r = B(f); return r; };
  const handle = (r) => {
    if (r === undefined) return 0;
    if (r.t === 1) return r.n > 1 ? mkBreak(r.n - 1) : 1;
    if (r.t === 2) return r.n > 1 ? mkCont(r.n - 1) : 0;
    return r;
  };
  if (obj.cls === generatorClass) {
    const g = obj.gen;
    g.ensure(true);
    while (!g.done) {
      if (byRef) { const rr = g.curRef || new Ref(g.cur); V.bind(f, rr); } else assignV(g.cur);
      if (K) K.set(f, g.key);
      const h = handle(run());
      if (h === 1) return; if (h !== 0) return h;
      g.next();
    }
    return;
  }
  if (obj.cls.ancestors.has('iterator')) {
    callMethodName(obj, 'rewind', []);
    while (toBool(callMethodName(obj, 'valid', []))) {
      const v = callMethodName(obj, 'current', []);
      if (byRef) V.bind(f, new Ref(v)); else assignV(v);
      if (K) K.set(f, callMethodName(obj, 'key', []));
      const h = handle(run());
      if (h === 1) return; if (h !== 0) return h;
      callMethodName(obj, 'next', []);
    }
    return;
  }
  if (obj.cls.ancestors.has('iteratoraggregate')) {
    const it = callMethodName(obj, 'getIterator', []);
    if (!(it instanceof PHPObject) || !it.cls.ancestors.has('traversable')) throwError('Exception', `Objects returned by ${obj.cls.name}::getIterator() must be traversable or implement interface Iterator`);
    return foreachObject(f, it, K, V, B, byRef, isList);
  }
  if (obj.cls.nativeIter) {
    const entries = obj.cls.nativeIter(obj);
    for (const [k, v] of entries) {
      assignV(v); if (K) K.set(f, k);
      const h = handle(run());
      if (h === 1) return; if (h !== 0) return h;
    }
    return;
  }
  // plain object: visible properties
  const keys = [...obj.props.keys()];
  for (const k of keys) {
    if (!obj.props.has(k)) continue;
    let name = k;
    if (k.charCodeAt(0) === 0) {
      const p = k.indexOf('\0', 1);
      if (!f.cls || f.cls.name !== k.slice(1, p)) continue;
      name = k.slice(p + 1);
    } else {
      const info = obj.cls.props.get(k);
      if (info && info.vis !== 'public' && !propAccessible(info, f.cls)) continue;
    }
    if (byRef) {
      let slot = obj.props.get(k);
      if (!(slot instanceof Ref)) { slot = new Ref(slot); obj.props.set(k, slot); }
      V.bind(f, slot);
    } else { const s = obj.props.get(k); assignV(s instanceof Ref ? s.v : s); }
    if (K) K.set(f, normKey(name));
    const h = handle(run());
    if (h === 1) return; if (h !== 0) return h;
  }
}

// iterate any Traversable with a JS callback (used by builtins)
function iterateObject(obj, cb) {
  if (obj.cls === generatorClass) {
    const g = obj.gen; g.ensure(true);
    while (!g.done) { if (cb(g.key, g.cur) === false) return; g.next(); }
    return;
  }
  if (obj.cls.ancestors.has('iterator')) {
    callMethodName(obj, 'rewind', []);
    while (toBool(callMethodName(obj, 'valid', []))) {
      const v = callMethodName(obj, 'current', []);
      const k = callMethodName(obj, 'key', []);
      if (cb(k, v) === false) return;
      callMethodName(obj, 'next', []);
    }
    return;
  }
  if (obj.cls.ancestors.has('iteratoraggregate')) return iterateObject(callMethodName(obj, 'getIterator', []), cb);
  if (obj.cls.nativeIter) { for (const [k, v] of obj.cls.nativeIter(obj)) if (cb(k, v) === false) return; return; }
  for (const [k, s] of [...obj.props]) {
    const info = obj.cls.props.get(k);
    if (info && info.vis !== 'public' && !canAccessMember(info, rt.frame ? rt.frame.cls : null)) continue;
    if (cb(normKey(k), s instanceof Ref ? s.v : s) === false) return;
  }
}

// ============================================================================
// Generator-mode compilation (bodies of functions containing yield)
// ============================================================================
function genWrap(fn) { return function* (f) { return fn(f); }; }

function cExprG(n) {
  if (!hasYield(n)) return genWrap(cExpr(n));
  switch (n.k) {
    case 'Yield': {
      const K = n.key ? cExprG(n.key) : null;
      const V = n.v ? cExprG(n.v) : null;
      const Lv = n.v && isLvalNode(n.v) && !hasYield(n.v) ? cLval(n.v) : null;
      return function* (f) {
        const k = K ? yield* K(f) : undefined;
        let v = null, ref = null;
        if (V) {
          if (Lv && f.fn && f.fn.byRef) { ref = Lv.ref(f); v = ref.v; }
          else v = cp(yield* V(f));
        }
        const sent = yield [k, v, false, ref];
        if (sent instanceof GenThrow) throw new ThrowSig(sent.obj);
        return sent === undefined ? null : sent;
      };
    }
    case 'YieldFrom': {
      const E = cExprG(n.e);
      return function* (f) {
        const src = yield* E(f);
        if (src instanceof PHPArray) {
          for (const [k, v] of src.entries()) yield [k, v, true];
          return null;
        }
        if (src instanceof PHPObject && src.cls === generatorClass) {
          const g = src.gen;
          if (g.done) return g.ret;
          g.ensure(true);
          while (!g.done) {
            const sent = yield [g.key, g.cur, true];
            if (sent instanceof GenThrow) g.throwIn(sent.obj); else g.send(sent === undefined ? null : sent);
          }
          return g.ret;
        }
        if (src instanceof PHPObject && src.cls.ancestors.has('traversable')) {
          const pairs = []; iterateObject(src, (k, v) => { pairs.push([k, v]); });
          for (const [k, v] of pairs) yield [k, v, true];
          return null;
        }
        throwError('Error', 'Can use "yield from" only with arrays and Traversables');
      };
    }
    case 'Ternary': {
      const C = cExprG(n.c), A = n.a ? cExprG(n.a) : null, B = cExprG(n.b);
      return function* (f) { const c = yield* C(f); if (toBool(c)) return A ? yield* A(f) : c; return yield* B(f); };
    }
    case 'And': { const A = cExprG(n.a), B = cExprG(n.b); return function* (f) { return toBool(yield* A(f)) && toBool(yield* B(f)); }; }
    case 'Or': { const A = cExprG(n.a), B = cExprG(n.b); return function* (f) { return toBool(yield* A(f)) || toBool(yield* B(f)); }; }
    case 'Coalesce': {
      const A = isLvalNode(n.a) && !hasYield(n.a) ? genWrap(cLval(n.a).getq) : cExprG(n.a);
      const B = cExprG(n.b);
      return function* (f) { const v = yield* A(f); return v === undefined || v === null ? yield* B(f) : v; };
    }
    case 'Match': {
      const E = cExprG(n.e);
      const arms = n.arms.map((a) => ({ conds: a.conds ? a.conds.map(cExprG) : null, body: cExprG(a.body) }));
      return function* (f) {
        const v = yield* E(f);
        let def = null;
        for (const arm of arms) {
          if (!arm.conds) { def = arm; continue; }
          for (const c of arm.conds) if (strictEq(v, yield* c(f))) return yield* arm.body(f);
        }
        if (def) return yield* def.body(f);
        throwError('UnhandledMatchError', `Unhandled match case ${matchRepr(v)}`);
      };
    }
  }
  // generic: hoist yield-containing sub-expressions into temporaries
  const hoisted = [];
  let tempId = 0;
  const replace = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(replace);
    if (!hasYield(node)) return node;
    if (['Yield', 'YieldFrom', 'Ternary', 'And', 'Or', 'Coalesce', 'Match'].includes(node.k)) {
      const id = 't' + (genTempCounter++) + '_' + (tempId++);
      hoisted.push({ id, G: cExprG(node) });
      return { k: 'Temp', id, l: node.l };
    }
    const copy = {};
    for (const key in node) { if (key === '_hy') continue; copy[key] = (key === 'l' || key === 'k') ? node[key] : replace(node[key]); }
    copy._hy = false;
    return copy;
  };
  const replaced = replace(n);
  const E = cExpr(replaced);
  return function* (f) {
    if (!f.temps) f.temps = Object.create(null);
    for (const h of hoisted) f.temps[h.id] = yield* h.G(f);
    return E(f);
  };
}
let genTempCounter = 0;

function cStmtsG(list) {
  const fns = list.map(cStmtG).filter(Boolean);
  return function* (f) {
    for (let i = 0; i < fns.length; i++) { const r = yield* fns[i](f); if (r !== undefined) return r; }
    return undefined;
  };
}
function cBodyG(n) { return n.k === 'Block' ? cStmtsG(n.body) : cStmtsG([n]); }

function cStmtG(n) {
  if (!n) return null;
  if (!hasYield(n)) { const s = cStmt(n); return s ? genWrap(s) : null; }
  const l = n.l;
  switch (n.k) {
    case 'Block': return cStmtsG(n.body);
    case 'Echo': {
      const args = n.args.map(cExprG);
      return function* (f) { rt.line = l; for (const a of args) rt.echo(toStr(yield* a(f))); };
    }
    case 'ExprStmt': { const E = cExprG(n.e); return function* (f) { rt.line = l; yield* E(f); }; }
    case 'Return': { const E = cExprG(n.e); return function* (f) { rt.line = l; f.ret = cp(yield* E(f)); return RETURN; }; }
    case 'If': {
      const conds = [cExprG(n.c), ...n.elifs.map((e) => cExprG(e.c))];
      const bodies = [cBodyG(n.then), ...n.elifs.map((e) => cBodyG(e.body))];
      const els = n.els ? cBodyG(n.els) : null;
      return function* (f) {
        rt.line = l;
        for (let i = 0; i < conds.length; i++) if (toBool(yield* conds[i](f))) return yield* bodies[i](f);
        if (els) return yield* els(f);
      };
    }
    case 'While': {
      const C = cExprG(n.c), B = cBodyG(n.body);
      return function* (f) {
        while (toBool(yield* C(f))) {
          const r = yield* B(f);
          if (r !== undefined) {
            if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
            if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
            return r;
          }
        }
      };
    }
    case 'DoWhile': {
      const C = cExprG(n.c), B = cBodyG(n.body);
      return function* (f) {
        do {
          const r = yield* B(f);
          if (r !== undefined) {
            if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
            if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
            return r;
          }
        } while (toBool(yield* C(f)));
      };
    }
    case 'For': {
      const init = n.init.map(cExprG), cond = n.cond.map(cExprG), step = n.step.map(cExprG), B = cBodyG(n.body);
      return function* (f) {
        for (const e of init) yield* e(f);
        for (;;) {
          let ok = true;
          for (let i = 0; i < cond.length; i++) { const v = yield* cond[i](f); if (i === cond.length - 1) ok = toBool(v); }
          if (!ok) break;
          const r = yield* B(f);
          if (r !== undefined) {
            if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
            if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); }
            else return r;
          }
          for (const e of step) yield* e(f);
        }
      };
    }
    case 'Foreach': {
      const E = cExprG(n.e);
      const LE = n.byRef ? cLval(n.e) : null;
      const K = n.kv ? cLval(n.kv) : null;
      const V = cLval(n.v);
      const isList = n.v.k === 'List';
      const B = cBodyG(n.body);
      return function* (f) {
        rt.line = l;
        let it;
        if (n.byRef) {
          const s0 = LE.getq(f);
          if (s0 instanceof PHPObject) it = objIterator(s0, f);
          else it = arrayRefIterator(LE.arr(f));
        } else {
          const subj = yield* E(f);
          if (subj instanceof PHPArray) it = arrayIterator(subj);
          else if (subj instanceof PHPObject) it = objIterator(subj, f);
          else { warn(`foreach() argument must be of type array|object, ${valueName(subj)} given`); return; }
        }
        try {
          while (it.next()) {
            if (n.byRef) V.bind(f, it.ref());
            else if (isList) V.listAssign(f, it.val, null);
            else V.set(f, cp(it.val));
            if (K) K.set(f, it.key);
            const r = yield* B(f);
            if (r !== undefined) {
              if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
              if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
              return r;
            }
          }
        } finally { it.done(); }
      };
    }
    case 'Switch': {
      const E = cExprG(n.e);
      const flat = []; const starts = []; let defIdx = -1;
      for (const c of n.cases) {
        starts.push({ T: c.test ? cExprG(c.test) : null, at: flat.length });
        if (!c.test) defIdx = starts.length - 1;
        for (const s of c.body) { const cs = cStmtG(s); if (cs) flat.push(cs); }
      }
      return function* (f) {
        const v = yield* E(f);
        let start = -1;
        for (const s of starts) if (s.T && looseEq(v, yield* s.T(f))) { start = s.at; break; }
        if (start < 0) { if (defIdx < 0) return; start = starts[defIdx].at; }
        for (let i = start; i < flat.length; i++) {
          const r = yield* flat[i](f);
          if (r !== undefined) {
            if (r.t === 1 || r.t === 2) { if (r.n > 1) return r.t === 1 ? mkBreak(r.n - 1) : mkCont(r.n - 1); return; }
            return r;
          }
        }
      };
    }
    case 'Try': {
      const B = cBodyG(n.body);
      const catches = n.catches.map((c) => ({ types: c.types.map((t) => t.toLowerCase()), v: c.v, B: cBodyG(c.body) }));
      const F = n.fin ? cBodyG(n.fin) : null;
      return function* (f) {
        let res;
        try {
          res = yield* B(f);
        } catch (e) {
          const sig = toThrowSig(e);
          if (!sig) throw e;
          const obj = sig.obj;
          for (const c of catches) {
            if (c.types.some((t) => obj.cls.ancestors.has(t))) {
              if (c.v) { const r = f.vars[c.v]; if (r) r.v = obj; else f.vars[c.v] = new Ref(obj); }
              if (F) {
                try { res = yield* c.B(f); }
                finally { const fr = yield* F(f); if (fr !== undefined) return fr; } // eslint-disable-line no-unsafe-finally
                return res;
              }
              return yield* c.B(f);
            }
          }
          if (F) { const fr = yield* F(f); if (fr !== undefined) return fr; }
          throw sig;
        }
        if (F) { const fr = yield* F(f); if (fr !== undefined) return fr; }
        return res;
      };
    }
  }
  // fallback: statements that only contain yields in expressions
  const s = cStmt(n);
  return genWrap(s);
}

function arrayIterator(a) {
  a.fe = (a.fe || 0) + 1;
  let i = -1;
  const it = {
    key: null, val: null,
    next() {
      for (i++; i < a.k.length; i++) {
        const k = a.k[i];
        if (k === undefined) continue;
        it.key = k; const v = a.v[i]; it.val = v instanceof Ref ? v.v : v; return true;
      }
      return false;
    },
    done() { a.fe--; },
  };
  return it;
}
function arrayRefIterator(a) {
  a.iters++;
  let i = -1;
  const it = {
    key: null,
    next() {
      for (i++; i < a.k.length; i++) { const k = a.k[i]; if (k === undefined) continue; it.key = k; return true; }
      return false;
    },
    ref() { let s = a.v[i]; if (!(s instanceof Ref)) { s = new Ref(s); a.v[i] = s; } return s; },
    done() { a.iters--; },
  };
  return it;
}
function objIterator(obj, f) {
  if (obj.cls === generatorClass) {
    const g = obj.gen; let first = true;
    const it = {
      key: null, val: null,
      next() { if (first) { g.ensure(true); first = false; } else g.next(); if (g.done) return false; it.key = g.key; it.val = g.cur; return true; },
      ref() { return g.curRef || new Ref(g.cur); },
      done() {},
    };
    return it;
  }
  if (obj.cls.ancestors.has('iterator')) {
    let first = true;
    const it = {
      key: null, val: null,
      next() {
        if (first) { callMethodName(obj, 'rewind', []); first = false; } else callMethodName(obj, 'next', []);
        if (!toBool(callMethodName(obj, 'valid', []))) return false;
        it.val = callMethodName(obj, 'current', []); it.key = callMethodName(obj, 'key', []); return true;
      },
      ref() { return new Ref(it.val); },
      done() {},
    };
    return it;
  }
  if (obj.cls.ancestors.has('iteratoraggregate')) return objIterator(callMethodName(obj, 'getIterator', []), f);
  const pairs = [];
  iterateObject(obj, (k, v) => { pairs.push([k, v]); });
  let i = -1;
  const it = {
    key: null, val: null,
    next() { i++; if (i >= pairs.length) return false; it.key = pairs[i][0]; it.val = pairs[i][1]; return true; },
    ref() { const k = String(it.key); let s = obj.props.get(k); if (!(s instanceof Ref)) { s = new Ref(s === undefined ? null : s); obj.props.set(k, s); } return s; },
    done() {},
  };
  return it;
}

// ============================================================================
// Runtime state
// ============================================================================
const E_ERROR = 1, E_WARNING = 2, E_PARSE = 4, E_NOTICE = 8, E_CORE_ERROR = 16, E_CORE_WARNING = 32, E_COMPILE_ERROR = 64,
  E_COMPILE_WARNING = 128, E_USER_ERROR = 256, E_USER_WARNING = 512, E_USER_NOTICE = 1024, E_STRICT = 2048,
  E_RECOVERABLE_ERROR = 4096, E_DEPRECATED = 8192, E_USER_DEPRECATED = 16384, E_ALL = 32767;

const rt = {
  fns: new Map(), userFnNames: new Set(), classes: new Map(), consts: new Map(), constsCI: new Set(),
  globals: Object.create(null), frame: null, globalFrame: null, line: 0, file: '', stack: [], depth: 0,
  silence: 0, errorReporting: E_ALL & ~E_DEPRECATED & ~E_STRICT, displayErrors: 'stderr',
  precision: 14, serializePrecision: -1, errorHandlers: [], exceptionHandlers: [], shutdownFns: [], autoloaders: [],
  included: new Set(), progCache: new Map(), obStack: [], outBuf: '', capture: null, ini: new Map(), mainStrict: false,
  destructibles: [], tz: 'UTC', inHandler: false, lastError: null, exitCode: 0, startTime: Date.now(),
  echo(s) {
    if (s.length === 0) return;
    const ob = rt.obStack;
    if (ob.length) { ob[ob.length - 1].buf += s; return; }
    rt.outBuf += s;
    if (rt.outBuf.length > 65536 || rt.ttyOut) rt.flush();
  },
  flush() {
    if (!rt.outBuf) return;
    const s = rt.outBuf; rt.outBuf = '';
    if (rt.capture) { rt.capture.push(s); return; }
    writeFd(1, Buffer.from(s, 'latin1'));
  },
};

function writeFd(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(fd, buf, off, buf.length - off); }
    catch (e) {
      if (e.code === 'EAGAIN') { sleepMs(1); continue; }
      if (e.code === 'EPIPE') return;
      throw e;
    }
  }
}
const sleepArr = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) { if (ms > 0) Atomics.wait(sleepArr, 0, 0, ms); }

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

function writeErr(msg) {
  rt.flush();
  if (rt.displayErrors === 'stdout') rt.echo('\n' + msg + '\n');
  else if (rt.capture) rt.capture.push('\nPHP ' + msg + '\n');
  else writeFd(2, Buffer.from('PHP ' + msg.replace(/^(\w[\w ]*?): /, '$1:  ') + '\n', 'latin1'));
}

function raise(type, msg) {
  rt.lastError = { type, message: msg, file: rt.file, line: rt.line };
  // user error handler
  if (rt.errorHandlers.length && !rt.inHandler) {
    const h = rt.errorHandlers[rt.errorHandlers.length - 1];
    if (h.handler !== null && (h.mask & type)) {
      rt.inHandler = true;
      let r;
      try { r = callValue(h.handler, [type, msg, rt.file, rt.line]); }
      finally { rt.inHandler = false; }
      if (r !== false) return;
    }
  }
  if (rt.silence) return;
  if (!(rt.errorReporting & type)) return;
  if (rt.displayErrors === '0' || rt.displayErrors === 'off') return;
  writeErr(`${errorTypeName(type)}: ${msg} in ${rt.file} on line ${rt.line}`);
}
function warn(msg) { raise(E_WARNING, msg); }
function notice(msg) { raise(E_NOTICE, msg); }
function deprecated(msg) { raise(E_DEPRECATED, msg); }

function throwError(clsName, msg, code) {
  const cls = rt.classes.get(clsName.toLowerCase());
  if (!cls) throw new FatalSig(msg);
  const obj = new PHPObject(cls);
  initProps(obj);
  initThrowable(obj);
  obj.props.set('message', msg);
  if (code !== undefined) obj.props.set('code', code);
  throw new ThrowSig(obj);
}
function makeException(clsName, msg) {
  const cls = lookupClass(clsName);
  const obj = new PHPObject(cls);
  initProps(obj);
  initThrowable(obj);
  obj.props.set('message', msg);
  return obj;
}

function toThrowSig(e) {
  if (e instanceof ThrowSig) return e;
  if (e instanceof RangeError && /call stack/i.test(e.message)) {
    try { throwError('Error', 'Maximum call stack size reached. Infinite recursion?'); } catch (s) { return s; }
  }
  return null;
}

// trace capture
function captureTrace(withArgs) {
  const tr = new PHPArray();
  const st = rt.stack;
  for (let i = st.length - 1; i >= 0; i--) {
    const s = st[i];
    const fr = new PHPArray();
    const calledFromNative = i > 0 && st[i - 1].native === true;
    if (!calledFromNative) { fr.set('file', s.callFile); fr.set('line', s.callLine); }
    fr.set('function', s.fn.isClosure ? '{closure}' : s.fn.name);
    if (s.fn.isMethod && (s.cls || s.this)) { fr.set('class', (s.fn.cls || s.cls || s.this.cls).name); fr.set('type', s.this ? '->' : '::'); }
    if (withArgs !== false) {
      const a = s.args || [];
      fr.set('args', PHPArray.from(Array.from(a, (x) => (x instanceof Ref ? x.v : x))));
    }
    tr.push(fr);
  }
  return tr;
}
function initThrowable(obj) {
  obj.props.set('file', rt.file);
  obj.props.set('line', rt.line);
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
function traceAsString(trace) {
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

// ============================================================================
// Functions
// ============================================================================
function fnDisplayName(fn) {
  if (!fn) return '';
  if (fn.isMethod && fn.cls) return fn.cls.name + '::' + fn.name;
  return fn.name;
}

function compileFunction(decl, opts = {}) {
  const params = decl.params.map((p) => {
    let type = p.type;
    if (type && p.def && p.def.k === 'Lit' && p.def.v === null && !type.nullable) type = { alts: type.alts, nullable: true };
    return { name: p.name, byRef: p.byRef, variadic: p.variadic, type, promote: p.promote, readonly: p.readonly, def: p.def ? cExpr(p.def) : null, defNode: p.def };
  });
  const refs = params.map((p) => p.byRef);
  const vi = params.findIndex((p) => p.variadic);
  const fn = {
    name: decl.name, decl, params, byRef: decl.byRef, ret: decl.ret, isGen: decl.isGen,
    file: decl.file, line: decl.l, strict: decl.strict,
    refs: refs.some(Boolean) ? refs : null, refRest: vi >= 0 && params[vi].byRef ? vi : null,
    body: null, statics: null, isMethod: !!opts.method, cls: opts.cls || null, isClosure: decl.name === '{closure}',
    required: params.filter((p) => !p.def && !p.variadic).length,
    simple: params.every((p) => !p.byRef && !p.variadic && !p.type && !p.promote),
  };
  if (fn.refs && fn.refRest !== null) fn.refs = refs.slice(0, vi);
  if (fn.refRest !== null && !fn.refs) fn.refs = [];
  return fn;
}
let compilingByRef = false;
const NOREF = new Ref(undefined);
function compileBody(fn) {
  const d = fn.decl;
  const saved = compilingByRef;
  compilingByRef = !!d.byRef;
  try {
    if (d.isGen) { if (!d._gbody) d._gbody = cStmtsG(d.body || []); fn.genBody = d._gbody; return null; }
    if (!d._body) d._body = cStmts(d.body || []);
    return (fn.body = d._body);
  } finally { compilingByRef = saved; }
}

function declareFunction(decl) {
  const lname = decl.name.toLowerCase();
  if (rt.fns.has(lname)) {
    const ex = rt.fns.get(lname);
    if (ex.decl === decl) return;
    throw new FatalSig(`Cannot redeclare ${ex.native ? '' : ''}${decl.name}()${ex.native ? '' : ` (previously declared in ${ex.file}:${ex.line})`}`, decl.l, decl.file);
  }
  const fn = compileFunction(decl);
  rt.fns.set(lname, fn);
  rt.userFnNames.add(lname);
}

function throwInCallee(fn, f, cls, msg) {
  const nf = f || new Frame(fn, null, null, null);
  nf.callLine = rt.line; nf.callFile = rt.file;
  const savedLine = rt.line, savedFile = rt.file;
  rt.stack.push(nf);
  rt.line = fn.line; rt.file = fn.file;
  try { throwError(cls, msg); }
  finally { rt.stack.pop(); rt.line = savedLine; rt.file = savedFile; }
}
function argCountError(fn, given, f) {
  const max = fn.params.some((p) => p.variadic) ? Infinity : fn.params.length;
  const word = fn.required === max ? 'exactly' : 'at least';
  const top = rt.stack[rt.stack.length - 1];
  const where = top && top.native === true ? '' : ` in ${rt.file} on line ${rt.line}`;
  throwInCallee(fn, f, 'ArgumentCountError', `Too few arguments to function ${fnDisplayName(fn)}(), ${given} passed${where} and ${word} ${fn.required} expected`);
}

function bindParams(fn, f, args) {
  const ps = fn.params, np = ps.length, na = args.length;
  const named = args.named;
  if (fn.simple === true && na >= np && named === undefined) {
    const vars = f.vars;
    for (let i = 0; i < np; i++) {
      let v = args[i];
      if (v instanceof Ref) v = v.v; else if (v instanceof PHPArray) v.cow = true;
      vars[ps[i].name] = new Ref(v);
    }
    return;
  }
  const strict = rt.frame && rt.frame.fn ? rt.frame.fn.strict : rt.mainStrict;
  for (let i = 0; i < np; i++) {
    const p = ps[i];
    if (p.variadic) {
      const rest = new PHPArray();
      for (let j = i; j < na; j++) {
        let a = args[j];
        if (p.byRef) rest.push(a instanceof Ref ? a : new Ref(a));
        else { if (a instanceof Ref) a = a.v; if (p.type) a = coerceParam(fn, p, j, a, strict, f); rest.push(cp(a)); }
      }
      if (named) for (const [k, v] of named) { if (!ps.some((q) => q.name === k && !q.variadic)) rest.set(k, cp(v instanceof Ref ? v.v : v)); }
      f.vars[p.name] = new Ref(rest);
      break;
    }
    let v;
    if (i < na) v = args[i];
    else if (named !== undefined && named.has(p.name)) v = named.get(p.name);
    else if (p.def) {
      v = p.def(f);
      if (p.type && v !== null) v = coerceParam(fn, p, i, v, false, f);
      f.vars[p.name] = new Ref(cp(v));
      if (p.promote) promoteParam(f, p, v);
      continue;
    } else argCountError(fn, na, f);
    if (p.byRef) {
      if (!(v instanceof Ref)) v = new Ref(v);
      f.vars[p.name] = v;
      if (p.promote) promoteParam(f, p, v.v);
      continue;
    }
    if (v instanceof Ref) v = v.v;
    if (p.type !== null && p.type !== undefined) v = coerceParam(fn, p, i, v, strict, f);
    if (v instanceof PHPArray) v.cow = true;
    f.vars[p.name] = new Ref(v);
    if (p.promote) promoteParam(f, p, v);
  }
  if (named !== undefined) {
    for (const k of named.keys()) {
      const idx = ps.findIndex((p) => p.name === k);
      if (idx < 0 && !ps.some((p) => p.variadic)) throwError('Error', `Unknown named parameter $${k}`);
      if (idx >= 0 && idx < na && !ps[idx].variadic) throwError('Error', `Named parameter $${k} overwrites previous argument`);
    }
  }
}
function promoteParam(f, p, v) {
  const obj = f.this;
  if (!obj) return;
  const info = obj.cls.props.get(p.name);
  obj.props.set(info ? info.key : p.name, cp(v));
}

const FAIL = { fail: true };
function typeStr(t) {
  const one = (a) => (typeof a === 'string' ? a : '(' + a.inter.join('&') + ')');
  if (t.alts.length === 1 && typeof t.alts[0] === 'object') return t.alts[0].inter.join('&') + (t.nullable ? '|null' : '');
  const s = t.alts.map(one).join('|');
  if (t.nullable) return t.alts.length === 1 && t.alts[0] !== 'mixed' ? '?' + s : (t.alts[0] === 'mixed' ? s : s + '|null');
  return s;
}
function matchType(alt, v, ctx) {
  switch (alt) {
    case 'mixed': return true;
    case 'int': return typeof v === 'number' || typeof v === 'bigint';
    case 'float': return v instanceof Flt;
    case 'string': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'true': return v === true;
    case 'false': return v === false;
    case 'array': return v instanceof PHPArray;
    case 'object': return v instanceof PHPObject;
    case 'iterable': return v instanceof PHPArray || (v instanceof PHPObject && v.cls.ancestors.has('traversable'));
    case 'callable': return isCallable(v);
    case 'null': case 'void': return v === null || v === undefined;
    case 'never': return false;
    case 'self': return v instanceof PHPObject && !!ctx && !!ctx.cls && v.cls.ancestors.has(ctx.cls.lname);
    case 'static': return v instanceof PHPObject && !!ctx && !!(ctx.sc || ctx.cls) && v.cls.ancestors.has((ctx.sc || ctx.cls).lname);
    case 'parent': return v instanceof PHPObject && !!ctx && !!ctx.cls && !!ctx.cls.parent && v.cls.ancestors.has(ctx.cls.parent.lname);
  }
  if (typeof alt === 'object') return alt.inter.every((a) => matchType(a, v, ctx));
  if (!(v instanceof PHPObject)) return false;
  return v.cls.ancestors.has(alt.toLowerCase());
}
function coerceType(type, v, strict, ctx) {
  if (v === null || v === undefined) {
    if (type.nullable) return null;
    for (const a of type.alts) if (a === 'mixed' || a === 'null' || a === 'void') return null;
    return FAIL;
  }
  const alts = type.alts;
  for (let i = 0; i < alts.length; i++) if (matchType(alts[i], v, ctx)) return v;
  const hasInt = alts.includes('int'), hasFloat = alts.includes('float'), hasStr = alts.includes('string');
  const hasBool = alts.includes('bool') || (alts.includes('true') && toBool(v)) || (alts.includes('false') && !toBool(v));
  if (strict) {
    if (isInt(v) && hasFloat) return mkf(Number(v));
    return FAIL;
  }
  if (isInt(v)) {
    if (hasFloat) return mkf(Number(v));
    if (hasStr) return toStr(v);
    if (hasBool) return toBool(v);
    return FAIL;
  }
  if (v instanceof Flt) {
    if (hasInt && isFinite(v.v)) {
      if (!Number.isInteger(v.v)) { if (!hasStr) { deprecated(`Implicit conversion from float ${fmtRepr(v.v)} to int loses precision`); return floatToInt(v.v); } }
      else return floatToInt(v.v);
    }
    if (hasStr) return toStr(v);
    if (hasBool) return toBool(v);
    return FAIL;
  }
  if (typeof v === 'string') {
    const num = numericStr(v);
    if (num !== null) {
      if (hasInt && !(num instanceof Flt)) return num;
      if (hasFloat) return num instanceof Flt ? num : mkf(Number(num));
      if (hasInt && num instanceof Flt && isFinite(num.v)) {
        if (Number.isInteger(num.v)) return floatToInt(num.v);
        deprecated(`Implicit conversion from float-string "${v}" to int loses precision`);
        return floatToInt(num.v);
      }
    }
    if (hasBool) return toBool(v);
    return FAIL;
  }
  if (typeof v === 'boolean') {
    if (hasInt) return v ? 1 : 0;
    if (hasFloat) return mkf(v ? 1 : 0);
    if (hasStr) return v ? '1' : '';
    return FAIL;
  }
  if (v instanceof PHPObject && hasStr && findMethod(v.cls, '__tostring')) return toStr(v);
  return FAIL;
}
function valueName(v) { return v === true ? 'true' : v === false ? 'false' : typeOf(v); }
function coerceParam(fn, p, i, v, strict, f) {
  const r = coerceType(p.type, v, strict, { cls: fn.cls, sc: f ? f.sc : (rt.frame ? rt.frame.sc : null) });
  if (r === FAIL) {
    const top = rt.stack[rt.stack.length - 1];
    const where = top && top.native === true ? '' : `, called in ${rt.file} on line ${rt.line}`;
    throwInCallee(fn, f, 'TypeError', `${fnDisplayName(fn)}(): Argument #${i + 1} ($${p.name}) must be of type ${typeStr(p.type)}, ${valueName(v)} given${where}`);
  }
  return r;
}
function checkReturn(fn, v, f, none) {
  const t = fn.ret;
  if (t.alts.length === 1) {
    const a = t.alts[0];
    if (a === 'void' || a === 'mixed') return v;
    if (a === 'never') throwError('TypeError', `${fnDisplayName(fn)}(): never-returning function must not implicitly return`);
  }
  const r = coerceType(t, v, fn.strict, { cls: fn.cls, sc: f.sc });
  if (r === FAIL) throwError('TypeError', `${fnDisplayName(fn)}(): Return value must be of type ${typeStr(t)}, ${none ? 'none' : valueName(v === undefined ? null : v)} returned`);
  return r;
}
function coercePropType(info, v, clsName, name) {
  const r = coerceType(info.type, v, rt.frame && rt.frame.fn ? rt.frame.fn.strict : rt.mainStrict, { cls: info.cls, sc: info.cls });
  if (r === FAIL) throwError('TypeError', `Cannot assign ${valueName(v)} to property ${clsName}::$${name} of type ${typeStr(info.type)}`);
  return r;
}

const MAX_DEPTH = 1000000;
function callFunction(fn, args, thisObj, cls, sc, closure) {
  if (fn.native !== undefined) {
    if (fn.isMethod) return callNativeMethod(fn, thisObj, args, sc);
    return callNative(fn, args);
  }
  const f = new Frame(fn, thisObj, cls, sc);
  if (closure !== null && closure !== undefined) {
    f.closure = closure;
    if (closure.bound) for (const [k, v] of closure.bound) f.vars[k] = v instanceof Ref ? v : new Ref(cp(v));
  }
  bindParams(fn, f, args);
  f.args = args;
  if (fn.isGen) return makeGenerator(fn, f);
  const body = fn.body || compileBody(fn);
  const prevFrame = rt.frame, prevLine = rt.line, prevFile = rt.file;
  if (++rt.depth > MAX_DEPTH) { rt.depth = 0; throw new FatalSig(`Maximum function nesting level of '${MAX_DEPTH}' reached, aborting!`); }
  rt.frame = f; rt.file = fn.file;
  f.callLine = prevLine; f.callFile = prevFile;
  rt.stack.push(f);
  let r;
  try { r = body(f); }
  finally { rt.stack.pop(); rt.frame = prevFrame; rt.line = prevLine; rt.file = prevFile; rt.depth--; }
  const ret = r === RETURN ? f.ret : null;
  if (f.retRef) rt.lastRetRef = f.retRef; else if (fn.byRef) rt.lastRetRef = NOREF;
  if (f.destr) gcAfterCall(f, ret);
  if (fn.ret !== null && fn.ret !== undefined) return checkReturn(fn, ret, f, r !== RETURN);
  return ret;
}

function callNative(fn, args) {
  if (args.length < fn.min) {
    if (args.named) args = mapNamedNative(fn, args);
    if (args.length < fn.min) throwError('ArgumentCountError', `${fn.name}() expects ${fn.max === fn.min ? 'exactly' : 'at least'} ${fn.min} argument${fn.min === 1 ? '' : 's'}, ${args.length} given`);
  } else if (args.named) args = mapNamedNative(fn, args);
  if (args.length > fn.max) throwError('ArgumentCountError', `${fn.name}() expects ${fn.max === fn.min ? 'exactly' : 'at most'} ${fn.max} argument${fn.max === 1 ? '' : 's'}, ${args.length} given`);
  const prev = rt.nativeName, prevArgs = rt.nativeArgs; rt.nativeName = fn.name; rt.nativeArgs = args;
  const st = rt.stack;
  st.push(new NativeFrame(fn, args));
  try {
    const r = fn.frame ? fn.native(rt.frame, ...args) : fn.native(...args);
    return r === undefined ? null : r;
  } finally { rt.nativeName = prev; rt.nativeArgs = prevArgs; st.pop(); }
}
class NativeFrame {
  constructor(fn, args) { this.fn = fn; this.args = args; this.callLine = rt.line; this.callFile = rt.file; this.this = null; this.cls = null; this.native = true; }
}
function mapNamedNative(fn, args) {
  const out = args.slice();
  const names = fn.pnames;
  if (!names) throwError('Error', `Named arguments are not supported for ${fn.name}()`);
  for (const [k, v] of args.named) {
    const i = names.indexOf(k);
    if (i < 0) throwError('Error', `Unknown named parameter $${k}`);
    while (out.length < i) out.push(fn.defaults && fn.defaults[out.length] !== undefined ? fn.defaults[out.length] : undefined);
    out[i] = v;
  }
  return out;
}
function callNativeMethod(fn, thisObj, args, sc) {
  const prev = rt.nativeName; rt.nativeName = fn.name;
  const nf = new NativeFrame(fn, args); nf.this = thisObj; nf.cls = fn.cls || (thisObj ? thisObj.cls : sc);
  rt.stack.push(nf);
  try { const r = fn.native(thisObj, args, sc); return r === undefined ? null : r; }
  finally { rt.nativeName = prev; rt.stack.pop(); }
}

// ---------------------------------------------------------------- frame-aware builtins
const FRAME_FUNCS = {
  compact(f, args) {
    const out = new PHPArray();
    const add = (v) => {
      if (v instanceof Ref) v = v.v;
      if (v instanceof PHPArray) { for (const x of v.values()) add(x); return; }
      const name = toStr(v);
      const r = f.vars[name];
      if (r !== undefined) out.set(normKey(name), cp(r.v));
      else if (name === 'this' && f.this) out.set('this', f.this);
      else warn(`compact(): Undefined variable $${name}`);
    };
    args.forEach(add);
    return out;
  },
  extract(f, args) {
    let a = args[0]; if (a instanceof Ref) a = a.v;
    if (!(a instanceof PHPArray)) throwError('TypeError', `extract(): Argument #1 ($array) must be of type array, ${typeOf(a)} given`);
    const flags = args.length > 1 ? toInt(args[1]) : 0;
    const prefix = args.length > 2 ? toStr(args[2]) : '';
    let n = 0;
    for (const [k, v] of a.entries()) {
      let name = String(k);
      const exists = f.vars[name] !== undefined;
      if (flags === 1 && exists) continue; // EXTR_SKIP
      if (flags === 2 && exists) name = prefix + '_' + name; // EXTR_PREFIX_SAME
      if (flags === 3) name = prefix + '_' + name; // EXTR_PREFIX_ALL
      if (!/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/.test(name) || name === 'this') continue;
      const r = f.vars[name];
      if (r) r.v = cp(v); else f.vars[name] = new Ref(cp(v));
      n++;
    }
    return n;
  },
  get_defined_vars(f) {
    const out = new PHPArray();
    for (const k of Object.keys(f.vars)) out.set(normKey(k), cp(f.vars[k].v));
    return out;
  },
  func_get_args(f) {
    if (!f.fn) throwError('Error', 'func_get_args() cannot be called from the global scope');
    const out = new PHPArray();
    const n = f.args.length;
    for (let i = 0; i < n; i++) {
      const p = f.fn.params[i];
      if (p && !p.variadic && f.vars[p.name]) out.push(cp(f.vars[p.name].v));
      else { const a = f.args[i]; out.push(cp(a instanceof Ref ? a.v : a)); }
    }
    return out;
  },
  func_num_args(f) { if (!f.fn) throwError('Error', 'func_num_args() must be called from a function context'); return f.args.length; },
  func_get_arg(f, args) {
    if (!f.fn) throwError('Error', 'func_get_arg() cannot be called from the global scope');
    const i = toInt(args[0]);
    if (i < 0) throwError('ValueError', 'func_get_arg(): Argument #1 ($position) must be greater than or equal to 0');
    if (i >= f.args.length) throwError('ValueError', 'func_get_arg(): Argument #1 ($position) must be less than the number of the arguments passed to the currently executed function');
    const p = f.fn.params[i];
    if (p && f.vars[p.name]) return f.vars[p.name].v;
    const a = f.args[i]; return a instanceof Ref ? a.v : (a === undefined ? null : a);
  },
  get_called_class(f) { return f.sc ? f.sc.name : false; },
};

// ============================================================================
// Callables & closures
// ============================================================================
let closureClass = null, generatorClass = null;

function makeClosure(fn, bound, thisObj, scope, sc) {
  const o = new PHPObject(closureClass);
  o.fn = fn; o.bound = bound; o.thisObj = thisObj || null; o.scope = scope || null; o.sc = sc || scope || null;
  return o;
}

function findMethod(cls, name) { return cls.methods.get(name.toLowerCase()) || null; }

function resolveCallable(v, f, throwIt) {
  const scope = f ? f.cls : null;
  const fail = (msg) => { if (throwIt) throwError('Error', msg); return null; };
  if (v instanceof PHPObject) {
    if (v.cls === closureClass) return { fn: v.fn, thisObj: v.thisObj, cls: v.scope, sc: v.sc, closure: v };
    const m = v.cls.methods.get('__invoke');
    if (m) return { fn: m.fn, thisObj: v, cls: m.cls, sc: v.cls, closure: null };
    return fail('Object of type ' + v.cls.name + ' is not callable');
  }
  if (typeof v === 'string') {
    let name = v[0] === '\\' ? v.slice(1) : v;
    const dc = name.indexOf('::');
    if (dc > 0) return resolveMethodCallable(name.slice(0, dc), name.slice(dc + 2), f, throwIt);
    const fn = rt.fns.get(name.toLowerCase()) || lazyFn(name.toLowerCase());
    if (!fn) return fail(`Call to undefined function ${name}()`);
    return { fn, thisObj: null, cls: null, sc: null, closure: null };
  }
  if (v instanceof PHPArray && v.size === 2) {
    const a = v.get(0), b = v.get(1);
    if (typeof b !== 'string') return fail('Array callback must have exactly two elements');
    if (a instanceof PHPObject) {
      let mname = b;
      let cls = a.cls;
      if (mname.toLowerCase().startsWith('parent::')) { cls = (scope || a.cls).parent; mname = mname.slice(8); }
      let m = null;
      if (scope && scope.privMethods) { const pm = scope.privMethods.get(mname.toLowerCase()); if (pm && a.cls.ancestors.has(scope.lname)) m = pm; }
      if (!m) m = cls.methods.get(mname.toLowerCase());
      if (!m || (m.vis !== 'public' && !canAccessMember(m, scope))) {
        const mc = a.cls.methods.get('__call');
        if (mc) return { fn: magicCallFn(mc, mname), thisObj: a, cls: mc.cls, sc: a.cls, closure: null };
        if (m) return fail(`Call to ${m.vis} method ${a.cls.name}::${m.name}() from ${scope ? 'scope ' + scope.name : 'global scope'}`);
        return fail(`Call to undefined method ${a.cls.name}::${mname}()`);
      }
      return { fn: m.fn, thisObj: m.static ? null : a, cls: m.cls, sc: a.cls, closure: null };
    }
    if (typeof a === 'string') return resolveMethodCallable(a, b, f, throwIt);
  }
  return fail(throwIt ? 'Value not callable' : '');
}
function magicCallFn(mc, name) {
  return { native: (thisObj, args) => callFunction(mc.fn, [name, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], thisObj, mc.cls, thisObj ? thisObj.cls : mc.cls, null), isMethod: true, name: mc.name, refs: null };
}
function resolveMethodCallable(cname, mname, f, throwIt) {
  const scope = f ? f.cls : null;
  const fail = (msg) => { if (throwIt) throwError('Error', msg); return null; };
  let cls;
  const lc = cname.toLowerCase();
  if (lc === 'self') cls = scope;
  else if (lc === 'static') cls = f ? f.sc : null;
  else if (lc === 'parent') cls = scope ? scope.parent : null;
  else cls = lookupClass(cname, !throwIt);
  if (!cls) return fail(`Class "${cname}" not found`);
  if (mname.toLowerCase().startsWith('parent::')) { cls = cls.parent; mname = mname.slice(8); }
  const m = cls.methods.get(mname.toLowerCase());
  if (!m) {
    const mc = cls.methods.get('__call');
    if (mc && f && f.this && f.this.cls.ancestors.has(cls.lname)) return { fn: magicCallFn(mc, mname), thisObj: f.this, cls: mc.cls, sc: f.this.cls, closure: null };
    const ms = cls.methods.get('__callstatic');
    if (ms) return { fn: { native: (t, args) => callFunction(ms.fn, [mname, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], null, ms.cls, cls, null), isMethod: true, name: mname, refs: null }, thisObj: null, cls, sc: cls, closure: null };
    return fail(`Call to undefined method ${cls.name}::${mname}()`);
  }
  if (m.vis !== 'public' && !canAccessMember(m, scope)) return fail(`Call to ${m.vis} method ${cls.name}::${m.name}() from ${scope ? 'scope ' + scope.name : 'global scope'}`);
  if (!m.static) {
    if (f && f.this && f.this.cls.ancestors.has(cls.lname)) return { fn: m.fn, thisObj: f.this, cls: m.cls, sc: f.this.cls, closure: null };
    return fail(`Non-static method ${cls.name}::${m.name}() cannot be called statically`);
  }
  const sc = (lc === 'parent' || lc === 'self') && f && f.sc ? f.sc : cls;
  return { fn: m.fn, thisObj: null, cls: m.cls, sc, closure: null };
}
function invokeCallable(c, args) { return callFunction(c.fn, args, c.thisObj, c.cls, c.sc, c.closure); }
function isCallable(v, f) {
  if (v instanceof PHPObject) return v.cls === closureClass || v.cls.methods.has('__invoke');
  if (typeof v !== 'string' && !(v instanceof PHPArray)) return false;
  try { return !!resolveCallable(v, f || rt.frame, false); } catch (e) { if (e instanceof ThrowSig) return false; throw e; }
}
// call a PHP callable from native code; args are plain values (or Refs for by-ref params)
function callValue(cb, args) {
  const c = resolveCallable(cb, rt.frame, true);
  return callFunction(c.fn, args, c.thisObj, c.cls, c.sc, c.closure);
}
function nativeCallback(cb) {
  if (!rt.nativeName) return resolveCallable(cb, rt.frame, true);
  let c = null;
  try { c = resolveCallable(cb, rt.frame, false); } catch (e) { if (!(e instanceof ThrowSig)) throw e; }
  if (c) return c;
  let reason;
  if (typeof cb === 'string') reason = cb.includes('::') ? `class "${cb.split('::')[0]}" not found or invalid method name` : `function "${cb}" not found or invalid function name`;
  else if (cb instanceof PHPArray) {
    if (cb.size !== 2) reason = 'array callback must have exactly two members';
    else { const o = cb.get(0), m = cb.get(1); const cn = o instanceof PHPObject ? o.cls.name : toStr(o); const cls = o instanceof PHPObject ? o.cls : classExists(cn, true); reason = !cls ? `class "${cn}" not found` : `class ${cls.name} does not have a method "${toStr(m)}"`; }
  } else reason = 'no array or string given';
  const i = argPos(cb);
  const fn = rt.fns.get(rt.nativeName.toLowerCase());
  const pn = fn && fn.pnames ? fn.pnames[i] : null;
  const orNull = rt.nativeName === 'array_map' ? ' or null' : '';
  throwError('TypeError', `${rt.nativeName}(): Argument #${i + 1}${pn ? ' ($' + pn + ')' : ''} must be a valid callback${orNull}, ${reason}`);
}
function callableFn(cb) { // returns a JS function for repeated invocation
  const c = nativeCallback(cb);
  return (...args) => callFunction(c.fn, args, c.thisObj, c.cls, c.sc, c.closure);
}
function callableRefs(cb) { const c = resolveCallable(cb, rt.frame, true); return c.fn; }
function callableToClosure(v, f) {
  if (v instanceof PHPObject && v.cls === closureClass) return v;
  const c = resolveCallable(v, f, true);
  return makeClosure(c.fn, null, c.thisObj, c.cls, c.sc);
}
function methodClosure(o, name, f) {
  const c = resolveCallable(PHPArray.from([o, name]), f, true);
  return makeClosure(c.fn, null, c.thisObj, c.cls, c.sc);
}
function callableName(v) {
  if (typeof v === 'string') return v;
  if (v instanceof PHPArray) { const a = v.get(0); return (a instanceof PHPObject ? a.cls.name : toStr(a)) + '::' + toStr(v.get(1)); }
  if (v instanceof PHPObject) return v.cls === closureClass ? 'Closure::__invoke' : v.cls.name + '::__invoke';
  return '';
}

// ============================================================================
// Classes & objects
// ============================================================================
class PHPClass {
  constructor(name) {
    this.name = name; this.lname = name.toLowerCase();
    this.parent = null; this.kind = 'class'; this.abstract = false; this.final = false; this.anon = false;
    this.isInterface = false; this.isTrait = false; this.isEnum = false; this.readonly = false;
    this.ancestors = new Set([this.lname]); this.ifaceList = [];
    this.consts = new Map(); this.sprops = new Map(); this.props = new Map(); this.privProps = new Map(); this.slots = new Map();
    this.methods = new Map(); this.privMethods = null;
    this.enumBacked = null; this.decl = null; this.nativeIter = null; this.toBoolHook = null; this.hasDestructor = false;
    this.propInit = null;
  }
}

function lookupClass(name, quiet) {
  if (name instanceof PHPClass) return name;
  let n = name[0] === '\\' ? name.slice(1) : name;
  const ln = n.toLowerCase();
  let c = rt.classes.get(ln);
  if (c !== undefined) return c;
  if (lazyClassSrc.has(ln)) { c = lazyClass(ln); if (c) return c; }
  // autoload
  if (rt.autoloaders.length && !rt.autoloading?.has(ln)) {
    if (!rt.autoloading) rt.autoloading = new Set();
    rt.autoloading.add(ln);
    try {
      for (const al of rt.autoloaders) {
        callValue(al, [n]);
        c = rt.classes.get(ln);
        if (c) return c;
      }
    } finally { rt.autoloading.delete(ln); }
  }
  if (quiet) return null;
  throwError('Error', `Class "${n}" not found`);
}
function classExists(name, autoload) {
  const ln = (name[0] === '\\' ? name.slice(1) : name).toLowerCase();
  if (rt.classes.has(ln)) return rt.classes.get(ln);
  if (lazyClassSrc.has(ln)) { const c = lazyClass(ln); if (c) return c; }
  if (autoload) return lookupClass(name, true);
  return null;
}

function constFrame(cls) { const f = new Frame(null, null, cls, cls); return f; }

function canAccessMember(m, scope) {
  if (m.vis === 'public') return true;
  if (!scope) return false;
  if (m.vis === 'private') return scope === m.cls;
  return scope.ancestors.has(m.cls.lname) || m.cls.ancestors.has(scope.lname) || (m.proto && scope.ancestors.has(m.proto.lname));
}

let anonSerial = 0;
const displayName = (cls) => { const i = cls.name.indexOf('\0'); return i < 0 ? cls.name : cls.name.slice(0, i); };
function declareClass(decl, f) {
  const lname = decl.name.toLowerCase();
  if (!decl.anon && rt.classes.has(lname)) {
    const ex = rt.classes.get(lname);
    if (ex.decl === decl) return ex;
    throw new FatalSig(`Cannot declare ${decl.kind} ${decl.name}, because the name is already in use`, decl.l, decl.file);
  }
  const cls = new PHPClass(decl.anon ? `${decl.parent || decl.interfaces[0] || 'class'}@anonymous\0${decl.file}:${decl.l}$${(anonSerial++).toString(16)}` : decl.name);
  if (decl.anon) { cls.anon = true; cls.ancestors = new Set([cls.lname]); }
  cls.decl = decl; cls.kind = decl.kind;
  cls.abstract = decl.flags.abstract; cls.final = decl.flags.final; cls.readonly = decl.flags.readonly;
  cls.isInterface = decl.kind === 'interface'; cls.isTrait = decl.kind === 'trait'; cls.isEnum = decl.kind === 'enum';
  const savedLine = rt.line, savedFile = rt.file;
  rt.line = decl.l; rt.file = decl.file;
  try {
    // parent
    if (decl.parent) {
      const p = lookupClass(decl.parent);
      if (p.isInterface) throw new FatalSig(`Class ${cls.name} cannot extend interface ${p.name}`, decl.l, decl.file);
      if (p.isTrait) throw new FatalSig(`Class ${cls.name} cannot extend trait ${p.name}`, decl.l, decl.file);
      if (p.final) throw new FatalSig(`Class ${cls.name} cannot extend final class ${p.name}`, decl.l, decl.file);
      inheritFrom(cls, p);
    }
    // interfaces
    for (const iname of decl.interfaces) {
      const ic = lookupClass(iname);
      if (!ic.isInterface) throw new FatalSig(`${cls.name} cannot implement ${ic.name} - it is not an interface`, decl.l, decl.file);
      addInterface(cls, ic);
    }
    if (cls.isEnum) {
      addInterface(cls, rt.classes.get('unitenum'));
      if (decl.enumType) addInterface(cls, rt.classes.get('backedenum'));
    }
    // traits
    for (const tu of decl.traits) useTraits(cls, tu, f);
    // constants
    for (const c of decl.consts) {
      const ex = cls.consts.get(c.name);
      if (ex && ex.final && ex.cls !== cls) throw new FatalSig(`${cls.name}::${c.name} cannot override final constant ${ex.cls.name}::${c.name}`, c.l, decl.file);
      cls.consts.set(c.name, { E: cExpr(c.e), val: undefined, done: false, cls, vis: c.vis, final: c.final });
    }
    // enum cases
    if (cls.isEnum) {
      cls.enumBacked = decl.enumType ? decl.enumType.alts[0] : null;
      cls.cases = [];
      for (const c of decl.cases) {
        const E = c.e ? cExpr(c.e) : null;
        const entry = { case: true, val: undefined, done: false, cls, vis: 'public', name: c.name, E: null };
        entry.make = () => {
          const o = new PHPObject(cls);
          o.props.set('name', c.name);
          if (E) o.props.set('value', E(constFrame(cls)));
          return o;
        };
        cls.consts.set(c.name, entry);
        cls.cases.push(c.name);
      }
      cls.props.set('name', { name: 'name', key: 'name', cls, vis: 'public', type: { alts: ['string'], nullable: false }, readonly: true, hasDef: false });
      if (cls.enumBacked) cls.props.set('value', { name: 'value', key: 'value', cls, vis: 'public', type: { alts: [cls.enumBacked], nullable: false }, readonly: true, hasDef: false });
      addEnumMethods(cls);
    }
    // properties
    for (const p of decl.props) addProp(cls, p, cls);
    // methods
    for (const m of decl.methods) addMethod(cls, m.fn, m, cls);
    // promoted ctor params
    const ctor = decl.methods.find((m) => m.fn.name.toLowerCase() === '__construct');
    if (ctor) for (const prm of ctor.fn.params) if (prm.promote) addProp(cls, { name: prm.name, def: null, hasDef: false, static: false, vis: prm.promote, type: prm.type, readonly: prm.readonly || cls.readonly }, cls);
    // abstract check
    if (!cls.abstract && !cls.isInterface && !cls.isTrait) {
      const abs = [...cls.methods.values()].filter((m) => m.abstract);
      if (abs.length) throw new FatalSig(`Class ${cls.name} contains ${abs.length} abstract method${abs.length > 1 ? 's' : ''} and must therefore be declared abstract or implement the remaining methods (${abs.map((m) => m.cls.name + '::' + m.name).join(', ')})`, decl.l, decl.file);
    }
    if (cls.parent || decl.traits.length) {
      const own = new Map(), rest = [];
      for (const [k, m] of cls.methods) { if (m.cls === cls) own.set(k, m); else rest.push([k, m]); }
      for (const [k, m] of rest) own.set(k, m);
      cls.methods = own;
    }
    if (cls.methods.has('__tostring')) cls.ancestors.add('stringable');
    cls.hasDestructor = cls.methods.has('__destruct');
    if (!decl.anon) { rt.classes.set(lname, cls); decl.declared = true; }
  } finally { rt.line = savedLine; rt.file = savedFile; }
  return cls;
}

function inheritFrom(cls, p) {
  cls.parent = p;
  for (const a of p.ancestors) cls.ancestors.add(a);
  cls.ifaceList.push(...p.ifaceList);
  for (const [k, v] of p.consts) cls.consts.set(k, v);
  for (const [k, v] of p.sprops) cls.sprops.set(k, v);
  for (const [k, v] of p.props) if (v.vis !== 'private') cls.props.set(k, v);
  for (const [k, v] of p.slots) cls.slots.set(k, v);
  for (const [k, v] of p.methods) cls.methods.set(k, v);
  cls.nativeIter = p.nativeIter; cls.toBoolHook = p.toBoolHook;
  if (p.nativeCtor) cls.nativeCtor = p.nativeCtor;
}
function addInterface(cls, ic) {
  for (const a of ic.ancestors) cls.ancestors.add(a);
  cls.ifaceList.push(ic);
  for (const [k, v] of ic.consts) if (!cls.consts.has(k)) cls.consts.set(k, v);
  for (const [k, m] of ic.methods) if (!cls.methods.has(k)) cls.methods.set(k, m);
}
function addProp(cls, p, owner) {
  const info = {
    name: p.name, key: p.vis === 'private' && !p.static ? `\0${owner.name}\0${p.name}` : p.name, cls: owner, vis: p.vis,
    type: p.type || null, readonly: !!p.readonly, hasDef: !!p.hasDef, defE: p.hasDef ? (p.defE || cExpr(p.def)) : null, val: undefined, evaluated: false, decl: p,
  };
  if (info.type && info.hasDef && p.def && p.def.k === 'Lit' && p.def.v === null && !info.type.nullable && !info.type.alts.includes('mixed')) { /* PHP: compile error; be lenient */ info.type = { alts: info.type.alts, nullable: true }; }
  if (p.static) {
    const ex = cls.sprops.get(p.name);
    if (ex && ex.cls !== owner && !p.hasDef && !ex.pending && false) return;
    const si = { name: p.name, cls: owner, vis: p.vis, type: info.type, readonly: info.readonly, ref: new Ref(null), pending: info.hasDef, defE: info.defE };
    if (!info.hasDef && info.type && !info.type.nullable) si.uninit = true;
    cls.sprops.set(p.name, si);
    return;
  }
  if (p.vis === 'private') {
    cls.privProps.set(p.name, info);
    cls.props.set(p.name, info);
    cls.slots.set(info.key, info);
    // a private redeclaration hides the parent's public/protected slot from this class's own scope
    if (cls.slots.has(p.name) && cls.slots.get(p.name).cls !== owner) { /* keep parent slot */ }
  } else {
    const ex = cls.props.get(p.name);
    if (ex && ex.vis === 'private' && ex.cls === owner) cls.slots.delete(ex.key);
    cls.props.set(p.name, info);
    cls.slots.set(info.key, info);
  }
  cls.propInit = null;
}
function addMethod(cls, decl, m, owner, alias) {
  const name = alias || decl.name;
  const lname = name.toLowerCase();
  const ex = cls.methods.get(lname);
  if (ex && ex.final && ex.cls !== owner && !ex.abstract) throw new FatalSig(`Cannot override final method ${ex.cls.name}::${ex.name}()`, m.l || decl.l, decl.file);
  if (ex && !m.abstract && ex.abstract === false && m.abstract) return;
  if (m.abstract && ex && !ex.abstract) return; // keep concrete implementation (e.g. from trait/parent)
  const fn = compileFunction(decl, { method: true, cls: owner });
  fn.name = name;
  if (lname === '__tostring' && !fn.ret) fn.ret = { alts: ['string'], nullable: false };
  const method = { name, fn, cls: owner, vis: m.vis, static: m.static, abstract: m.abstract || !decl.body, final: m.final, proto: ex && ex.vis !== 'private' && (lname !== '__construct' || ex.abstract) ? (ex.proto || ex.cls) : null };
  if (decl.body === null && !cls.isInterface && !m.abstract) method.abstract = true;
  cls.methods.set(lname, method);
  if (m.vis === 'private') { if (!cls.privMethods) cls.privMethods = new Map(); cls.privMethods.set(lname, method); }
}
function useTraits(cls, tu, f) {
  const traits = tu.names.map((n) => {
    const t = lookupClass(n);
    if (!t.isTrait) throw new FatalSig(`${cls.name} cannot use ${t.name} - it is not a trait`, cls.decl.l, cls.decl.file);
    return t;
  });
  const excluded = new Map(); // lname -> Set of trait lnames excluded
  for (const r of tu.rules) if (r.kind === 'insteadof') for (const ex of r.excl) {
    const k = r.method.toLowerCase();
    if (!excluded.has(k)) excluded.set(k, new Set());
    excluded.get(k).add(ex.toLowerCase());
  }
  for (const t of traits) {
    for (const [ln, m] of t.methods) {
      if (excluded.has(ln) && excluded.get(ln).has(t.lname)) continue;
      const ownDefined = cls.decl.methods.some((om) => om.fn.name.toLowerCase() === ln);
      if (!ownDefined) {
        let vis = m.vis;
        for (const r of tu.rules) if (r.kind === 'as' && !r.alias && r.method.toLowerCase() === ln && (!r.trait || r.trait.toLowerCase() === t.lname) && r.vis) vis = r.vis;
        const ex = cls.methods.get(ln);
        if (!(m.abstract && ex && !ex.abstract)) addMethod(cls, m.fn.decl, { vis, static: m.static, abstract: m.abstract, final: m.final }, cls);
      }
      for (const r of tu.rules) {
        if (r.kind === 'as' && r.alias && r.method.toLowerCase() === ln && (!r.trait || r.trait.toLowerCase() === t.lname)) {
          addMethod(cls, m.fn.decl, { vis: r.vis || m.vis, static: m.static, abstract: m.abstract, final: m.final }, cls, r.alias);
        }
      }
    }
    for (const [, info] of t.slots) addProp(cls, Object.assign({}, info.decl, { defE: info.defE }), cls);
    for (const [, si] of t.sprops) addProp(cls, { name: si.name, def: null, hasDef: !!si.defE, defE: si.defE, static: true, vis: si.vis, type: si.type, readonly: si.readonly }, cls);
    for (const [k, c] of t.consts) if (!cls.consts.has(k)) cls.consts.set(k, { E: c.E, val: undefined, done: false, cls, vis: c.vis });
    for (const a of t.traitIfaces || []) cls.ancestors.add(a);
  }
}

function addEnumMethods(cls) {
  const mk = (name, native, isStatic = true) => cls.methods.set(name.toLowerCase(), { name, cls, vis: 'public', static: isStatic, abstract: false, final: false, fn: { native, isMethod: true, name, refs: null, cls } });
  mk('cases', () => PHPArray.from(cls.cases.map((n) => classConst(cls, n))));
  if (cls.enumBacked) {
    const find = (v) => {
      for (const n of cls.cases) { const o = classConst(cls, n); const cv = o.props.get('value'); if (looseEq(cv, v) && (typeof cv === typeof v || isNum(cv) === isNum(v))) return o; }
      return null;
    };
    const norm = (v) => {
      if (cls.enumBacked === 'int') {
        if (isInt(v)) return v;
        const r = coerceType({ alts: ['int'], nullable: false }, v, false, null);
        if (r === FAIL) throwError('TypeError', `${cls.name}::from(): Argument #1 ($value) must be of type int, ${typeOf(v)} given`);
        return r;
      }
      return toStr(v);
    };
    mk('from', (t, args) => {
      const v = norm(args[0] instanceof Ref ? args[0].v : args[0]);
      const r = find(v);
      if (!r) throwError('ValueError', `${typeof v === 'string' ? '"' + v + '"' : toStr(v)} is not a valid backing value for enum ${cls.name.includes('\\') ? cls.name : cls.name}`);
      return r;
    });
    mk('tryFrom', (t, args) => find(norm(args[0] instanceof Ref ? args[0].v : args[0])));
  }
}

function classConst(cls, name, f) {
  const c = cls.consts.get(name);
  if (c === undefined) throwError('Error', `Undefined constant ${cls.name}::${name}`);
  if (c.vis === 'private' && f && f.cls !== c.cls) throwError('Error', `Cannot access private constant ${cls.name}::${name}`);
  if (!c.done) {
    if (c.evaluating) throwError('Error', `Cannot declare self-referencing constant ${c.cls.name}::${name}`);
    c.evaluating = true;
    try { c.val = c.case ? c.make() : c.E(constFrame(c.cls)); }
    finally { c.evaluating = false; }
    c.done = true;
    if (c.val instanceof PHPArray) c.val.cow = true;
  }
  return c.val;
}

function lookupStaticProp(cls, name) {
  const si = cls.sprops.get(name);
  if (!si) return null;
  if (si.pending) { si.pending = false; si.ref.v = cp(si.defE(constFrame(si.cls))); }
  return si;
}
function findStaticProp(cls, name, f) {
  const si = lookupStaticProp(cls, name);
  if (!si) throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
  if (si.vis !== 'public' && !canAccessMember(si, f ? f.cls : null)) throwError('Error', `Cannot access ${si.vis} property ${cls.name}::$${name}`);
  if (si.uninit) { if (si.ref.v === null) { /* allow writes */ } }
  return si;
}

function propDefault(info) {
  if (!info.evaluated) { info.val = info.defE(constFrame(info.cls)); info.evaluated = true; if (info.val instanceof PHPArray) info.val.cow = true; }
  return info.val;
}
function initProps(obj) {
  const cls = obj.cls;
  let pi = cls.propInit;
  if (pi === null) {
    pi = [];
    for (const info of cls.slots.values()) {
      if (info.hasDef) pi.push([info.key, propDefault(info)]);
      else if (!info.type) pi.push([info.key, null]);
    }
    cls.propInit = pi;
  }
  const props = obj.props;
  for (let i = 0; i < pi.length; i++) { const v = pi[i][1]; if (v instanceof PHPArray) v.cow = true; props.set(pi[i][0], v); }
}

function instantiate(cls, A, f) {
  if (cls.abstract || cls.isInterface || cls.isTrait || cls.isEnum) {
    const what = cls.isInterface ? 'interface' : cls.isTrait ? 'trait' : cls.isEnum ? 'enum' : 'abstract class';
    throwError('Error', `Cannot instantiate ${what} ${cls.name}`);
  }
  const obj = new PHPObject(cls);
  initProps(obj);
  if (cls.ancestors.has('throwable')) initThrowable(obj);
  const ctor = cls.methods.get('__construct');
  if (ctor) {
    if (ctor.vis !== 'public' && !canAccessMember(ctor, f ? f.cls : null)) throwError('Error', `Call to ${ctor.vis} ${cls.name}::__construct() from ${f && f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
    const args = A ? A(f, ctor.fn) : [];
    if (cls.hasDestructor) {
      try { callFunction(ctor.fn, args, obj, ctor.cls, cls, null); }
      catch (e) { if (e instanceof ThrowSig) { trackDestructible(obj); gcCollect([obj], [e.obj]); } throw e; }
    } else callFunction(ctor.fn, args, obj, ctor.cls, cls, null);
  } else if (A) A(f, null);
  if (cls.hasDestructor && !rt.destructibles.includes(obj)) trackDestructible(obj);
  return obj;
}
function trackDestructible(obj) {
  rt.destructibles.push(obj);
  const fr = rt.frame;
  if (fr && fr !== rt.globalFrame) (fr.destr || (fr.destr = [])).push(obj);
}
function newObject(clsName, args) { // from native code
  const cls = lookupClass(clsName);
  return instantiate(cls, () => args, rt.frame);
}

function callMethodName(obj, name, args) {
  const m = obj.cls.methods.get(name.toLowerCase());
  if (!m) {
    const mc = obj.cls.methods.get('__call');
    if (mc) return callFunction(mc.fn, [name, PHPArray.from(args)], obj, mc.cls, obj.cls, null);
    throwError('Error', `Call to undefined method ${obj.cls.name}::${name}()`);
  }
  return callFunction(m.fn, args, m.static ? null : obj, m.cls, obj.cls, null);
}
function callMethod(obj, m, args) { return callFunction(m.fn, args, obj, m.cls, obj.cls, null); }

// ---------------------------------------------------------------- property access
function propInfoFor(obj, name, scope) {
  if (scope !== null && scope !== undefined) {
    const pi = scope.privProps.size ? scope.privProps.get(name) : undefined;
    if (pi !== undefined && (obj.cls === scope || obj.cls.ancestors.has(scope.lname))) return pi;
  }
  return obj.cls.props.get(name);
}
function propAccessible(info, scope) {
  if (info.vis === 'public') return true;
  if (!scope) return false;
  if (info.vis === 'private') return scope === info.cls;
  return scope.ancestors.has(info.cls.lname) || info.cls.ancestors.has(scope.lname);
}
function guardEnter(obj, kind, name) {
  if (!obj.guards) obj.guards = new Set();
  const k = kind + name;
  if (obj.guards.has(k)) return false;
  obj.guards.add(k);
  return true;
}
function guardLeave(obj, kind, name) { obj.guards.delete(kind + name); }
function magicGet(obj, name) {
  const m = obj.cls.methods.get('__get');
  if (!m || !guardEnter(obj, 'g', name)) return undefined;
  try { return callFunction(m.fn, [name], obj, m.cls, obj.cls, null); } finally { guardLeave(obj, 'g', name); }
}

function readProp(obj, name, f) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) {
      const r = magicGet(obj, name);
      if (r !== undefined) return r;
      throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
    }
    key = info.key;
  }
  const slot = obj.props.get(key);
  if (slot !== undefined) return slot instanceof Ref ? slot.v : slot;
  if (obj.cls.nativeGet) { const r = obj.cls.nativeGet(obj, name); if (r !== undefined) return r; }
  const r = magicGet(obj, name);
  if (r !== undefined) return r;
  if (info && info.type) throwError('Error', `Typed property ${info.cls.name}::$${name} must not be accessed before initialization`);
  if (obj.cls.sprops.has(name)) notice(`Accessing static property ${obj.cls.name}::$${name} as non static`);
  warn(`Undefined property: ${obj.cls.name}::$${name}`);
  return null;
}
function readPropQuiet(obj, name, f, issetOnly) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) return magicIsset(obj, name, issetOnly);
    key = info.key;
  }
  const slot = obj.props.get(key);
  if (slot !== undefined) return slot instanceof Ref ? slot.v : slot;
  if (obj.cls.nativeGet) { const r = obj.cls.nativeGet(obj, name); if (r !== undefined) return r; }
  return magicIsset(obj, name, issetOnly);
}
function magicIsset(obj, name, issetOnly) {
  const mi = obj.cls.methods.get('__isset');
  if (!mi || !guardEnter(obj, 'i', name)) return undefined;
  let ok;
  try { ok = toBool(callFunction(mi.fn, [name], obj, mi.cls, obj.cls, null)); } finally { guardLeave(obj, 'i', name); }
  if (!ok) return undefined;
  if (issetOnly) return true;
  const r = magicGet(obj, name);
  return r === undefined ? null : r;
}
function writeProp(obj, name, v, f) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) {
      if (magicSet(obj, name, v)) return;
      if (info.readonly && info.vis !== 'private') throwError('Error', `Cannot modify ${info.vis} readonly property ${obj.cls.name}::$${name}`);
      throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
    }
    key = info.key;
    if (info.readonly) {
      if (obj.props.has(key)) throwError('Error', `Cannot modify readonly property ${obj.cls.name}::$${name}`);
      if (scope !== info.cls) throwError('Error', `Cannot initialize readonly property ${obj.cls.name}::$${name} from ${scope ? 'scope ' + scope.name : 'global scope'}`);
    }
    if (info.type !== null) v = coercePropType(info, v, obj.cls.name, name);
    if (!obj.props.has(key) && obj.cls.methods.has('__set') && !info.type && false) { /* declared-but-unset */ }
  } else if (!obj.props.has(name)) {
    if (magicSet(obj, name, v)) return;
    if (obj.cls.sprops.has(name)) notice(`Accessing static property ${obj.cls.name}::$${name} as non static`);
    if (obj.cls.isEnum) throwError('Error', `Cannot create dynamic property ${obj.cls.name}::$${name}`);
    if (obj.cls.noDynamic) throwError('Error', `Cannot create dynamic property ${obj.cls.name}::$${name}`);
  }
  const slot = obj.props.get(key);
  if (slot instanceof Ref) slot.v = v; else obj.props.set(key, v);
  if (slot instanceof PHPObject && slot !== v && slot.cls.hasDestructor) gcCheck(slot);
}
function magicSet(obj, name, v) {
  const m = obj.cls.methods.get('__set');
  if (!m || !guardEnter(obj, 's', name)) return false;
  try { callFunction(m.fn, [name, v], obj, m.cls, obj.cls, null); } finally { guardLeave(obj, 's', name); }
  return true;
}
function resolvePropKey(obj, name, f, forWrite) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  if (info === undefined) return [name, null];
  if (info.vis !== 'public' && !propAccessible(info, scope)) throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
  if (forWrite && info.readonly && obj.props.has(info.key)) throwError('Error', `Cannot modify readonly property ${obj.cls.name}::$${name}`);
  return [info.key, info];
}
function bindProp(obj, name, ref, f) {
  const [key] = resolvePropKey(obj, name, f, true);
  obj.props.set(key, ref);
}
function propRef(obj, name, f) {
  const [key, info] = resolvePropKey(obj, name, f, true);
  const slot = obj.props.get(key);
  if (slot instanceof Ref) return slot;
  if (slot === undefined && !info) {
    rt.lastRetRef = null;
    const r = magicGet(obj, name);
    const rr = rt.lastRetRef; rt.lastRetRef = null;
    if (r !== undefined) { if (rr !== null && rr !== NOREF) return rr; notice(`Indirect modification of overloaded property ${obj.cls.name}::$${name} has no effect`); return new Ref(r); }
  }
  const r = new Ref(slot === undefined ? null : slot);
  obj.props.set(key, r);
  return r;
}
function propArr(obj, name, f) {
  const [key, info] = resolvePropKey(obj, name, f, false);
  let slot = obj.props.get(key);
  if (slot === undefined && !info) {
    rt.lastRetRef = null;
    const r = magicGet(obj, name);
    const rr = rt.lastRetRef; rt.lastRetRef = null;
    if (r !== undefined) {
      if (r instanceof PHPObject) return r;
      if (rr !== null && rr !== NOREF) return writableArrIn(rr);
      notice(`Indirect modification of overloaded property ${obj.cls.name}::$${name} has no effect`);
      return r instanceof PHPArray ? r.clone() : new PHPArray();
    }
  }
  const isRef = slot instanceof Ref;
  let v = isRef ? slot.v : slot;
  if (v instanceof PHPObject) return v;
  if (info && info.readonly && obj.props.has(key)) throwError('Error', `Cannot modify readonly property ${obj.cls.name}::$${name}`);
  if (v instanceof PHPArray) {
    if (v.cow || v.fe) { v = v.clone(); if (isRef) slot.v = v; else obj.props.set(key, v); }
    return v;
  }
  if (v === null || v === undefined) {
    if (info && info.type && v === undefined && !info.type.alts.includes('array') && !info.type.alts.includes('mixed') && !info.type.alts.includes('iterable')) throwError('Error', `Typed property ${obj.cls.name}::$${name} must not be accessed before initialization`);
    const na = new PHPArray();
    if (isRef) slot.v = na; else obj.props.set(key, na);
    return na;
  }
  throwError('Error', 'Cannot use a scalar value as an array');
}
function unsetProp(obj, name, f) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) {
      const m = obj.cls.methods.get('__unset');
      if (m) { callFunction(m.fn, [name], obj, m.cls, obj.cls, null); return; }
      throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
    }
    if (info.readonly) throwError('Error', `Cannot unset readonly property ${obj.cls.name}::$${name}`);
    key = info.key;
  }
  if (obj.props.has(key)) { const old = obj.props.get(key); obj.props.delete(key); gcCheck(old instanceof Ref ? old.v : old); return; }
  const m = obj.cls.methods.get('__unset');
  if (m && guardEnter(obj, 'u', name)) { try { callFunction(m.fn, [name], obj, m.cls, obj.cls, null); } finally { guardLeave(obj, 'u', name); } }
}

function cloneObject(o, f) {
  if (!(o instanceof PHPObject)) throwError('Error', '__clone method called on non-object');
  if (o.cls.isEnum) throwError('Error', `Trying to clone an uncloneable object of class ${o.cls.name}`);
  if (o.cls === generatorClass) throwError('Error', 'Trying to clone an uncloneable object of class Generator');
  const c = new PHPObject(o.cls);
  for (const [k, v] of o.props) c.props.set(k, cp(v instanceof Ref ? v.v : v));
  for (const key of ['fn', 'bound', 'thisObj', 'scope', 'sc', 'trace', 'native']) if (o[key] !== undefined) c[key] = o[key];
  if (o.cls.nativeClone) o.cls.nativeClone(o, c);
  const m = o.cls.methods.get('__clone');
  if (m) {
    if (m.vis !== 'public' && !canAccessMember(m, f ? f.cls : null)) throwError('Error', `Call to ${m.vis} ${o.cls.name}::__clone() from ${f && f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
    c.cloning = true;
    try { callFunction(m.fn, [], c, m.cls, c.cls, null); } finally { c.cloning = false; }
  }
  if (o.cls.hasDestructor) trackDestructible(c);
  return c;
}

// visible props as [name, value] pairs for a given scope
function objVisibleProps(obj, scope) {
  const out = [];
  for (const [k, s] of obj.props) {
    const v = s instanceof Ref ? s.v : s;
    if (k.charCodeAt(0) === 0) {
      const p = k.indexOf('\0', 1);
      const owner = k.slice(1, p), name = k.slice(p + 1);
      if (scope && scope.name === owner) out.push([name, v]);
      continue;
    }
    const info = obj.cls.props.get(k);
    if (info && info.vis !== 'public' && !propAccessible(info, scope)) continue;
    out.push([k, v]);
  }
  return out;
}

function toArrayCast(v) {
  if (v instanceof PHPArray) return v;
  if (v === null || v === undefined) return new PHPArray();
  if (v instanceof PHPObject) {
    if (v.cls === closureClass) return PHPArray.from([v]);
    if (v.cls.nativeToArray) return v.cls.nativeToArray(v);
    const a = new PHPArray();
    for (const [k, s] of v.props) {
      const val = s instanceof Ref ? s.v : s;
      const info = v.cls.props.get(k);
      let key = k;
      if (info && info.vis === 'protected') key = '\0*\0' + k;
      a.set(normKey(key), cp(val));
    }
    return a;
  }
  return PHPArray.from([v]);
}
function toObjectCast(v) {
  if (v instanceof PHPObject) return v;
  const o = new PHPObject(rt.classes.get('stdclass'));
  if (v instanceof PHPArray) { for (const [k, x] of v.entries()) o.props.set(String(k), cp(x)); }
  else if (v !== null && v !== undefined) o.props.set('scalar', v);
  return o;
}


// ============================================================================
// Destructor support: targeted reachability checks emulate PHP's refcount-based
// destruction timing for objects that define __destruct().
// ============================================================================
function gcVisitRoots(push, extra) {
  const g = rt.globals;
  for (const k in g) push(g[k]);
  for (const e of rt.stack) push(e);
  if (rt.frame) push(rt.frame);
  if (rt.mainStatics) push(rt.mainStatics);
  const seenFn = new Set();
  const fnRoots = (fn) => { if (!fn || seenFn.has(fn)) return; seenFn.add(fn); if (fn.statics) push(fn.statics); if (fn.staticsByClass) for (const m of fn.staticsByClass.values()) push(m); };
  for (const fn of rt.fns.values()) if (!fn.native) fnRoots(fn);
  for (const cls of new Set(rt.classes.values())) {
    for (const si of cls.sprops.values()) push(si.ref);
    for (const m of cls.methods.values()) fnRoots(m.fn);
    for (const c of cls.consts.values()) if (c.done) push(c.val);
  }
  for (const h of rt.errorHandlers) push(h.handler);
  for (const h of rt.exceptionHandlers) push(h);
  for (const [cb, a] of rt.shutdownFns) { push(cb); push(a); }
  for (const a of rt.autoloaders) push(a);
  for (const ob of rt.obStack) if (ob.cb) push(ob.cb);
  if (extra) for (const x of extra) push(x);
}
function gcTraverse(cands, extra, countMode) {
  const seen = new Set();
  const stack = [];
  const push = (v) => { if (v !== null && typeof v === 'object' && !(v instanceof Flt)) stack.push(v); };
  gcVisitRoots(push, extra);
  let remaining = cands ? cands.size : 0;
  const counts = countMode ? new Map() : null;
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PHPObject && countMode && v.cls.hasDestructor) counts.set(v, (counts.get(v) || 0) + 1);
    if (seen.has(v)) continue;
    seen.add(v);
    if (cands && v instanceof PHPObject && cands.has(v)) { if (--remaining === 0 && !countMode) return seen; }
    if (v instanceof Ref) push(v.v);
    else if (v instanceof PHPArray) { const vs = v.v, ks = v.k; for (let i = 0; i < vs.length; i++) if (ks[i] !== undefined) push(vs[i]); }
    else if (v instanceof PHPObject) {
      for (const x of v.props.values()) push(x);
      if (v.bound) for (const x of v.bound.values()) push(x);
      if (v.thisObj) push(v.thisObj);
      if (v.statics) push(v.statics);
      if (v.gen) push(v.gen.f);
    } else if (v instanceof Frame) {
      for (const k in v.vars) push(v.vars[k]);
      if (v.this) push(v.this);
      if (v.args) push(v.args);
      if (v.temps) for (const k in v.temps) push(v.temps[k]);
      if (v.closure) push(v.closure);
      if (v.ret) push(v.ret);
    } else if (v instanceof Map) { for (const x of v.values()) push(x); }
    else if (Array.isArray(v)) { for (const x of v) push(x); }
  }
  return countMode ? counts : seen;
}
// count how many holders (variables, array slots, properties, ...) share each reference
function refHolderCounts(extra) {
  const counts = new Map();
  const seen = new Set();
  const stack = [];
  const holder = (v) => { if (v instanceof Ref) counts.set(v, (counts.get(v) || 0) + 1); if (v !== null && typeof v === 'object' && !(v instanceof Flt)) stack.push(v); };
  const g = rt.globals;
  for (const k in g) holder(g[k]);
  seen.add(rt.globalFrame);
  if (rt.globalFrame) seen.add(rt.globalFrame.vars);
  for (const e of rt.stack) if (e instanceof Frame && e !== rt.globalFrame) stack.push(e);
  if (rt.frame && rt.frame !== rt.globalFrame) stack.push(rt.frame);
  for (const fn of rt.fns.values()) if (!fn.native && fn.statics) stack.push(fn.statics);
  for (const cls of new Set(rt.classes.values())) for (const si of cls.sprops.values()) holder(si.ref);
  if (extra) for (const x of extra) stack.push(x);
  while (stack.length) {
    const v = stack.pop();
    if (seen.has(v)) continue;
    seen.add(v);
    if (v instanceof Ref) { const x = v.v; if (x !== null && typeof x === 'object' && !(x instanceof Flt)) stack.push(x); }
    else if (v instanceof PHPArray) { const vs = v.v, ks = v.k; for (let i = 0; i < vs.length; i++) if (ks[i] !== undefined) holder(vs[i]); }
    else if (v instanceof PHPObject) {
      for (const x of v.props.values()) holder(x);
      if (v.bound) for (const x of v.bound.values()) holder(x);
      if (v.statics) stack.push(v.statics);
      if (v.gen) stack.push(v.gen.f);
    } else if (v instanceof Frame) { for (const k in v.vars) holder(v.vars[k]); if (v.this) stack.push(v.this); }
    else if (v instanceof Map) { for (const x of v.values()) holder(x); }
  }
  return counts;
}
function containsRefSlot(v, seen) {
  if (v instanceof PHPArray) {
    if (seen.has(v)) return false; seen.add(v);
    for (let i = 0; i < v.v.length; i++) { const x = v.v[i]; if (x instanceof Ref) return true; if (x instanceof PHPArray && containsRefSlot(x, seen)) return true; if (x instanceof PHPObject && containsRefSlot(x, seen)) return true; }
    return false;
  }
  if (v instanceof PHPObject) {
    if (seen.has(v)) return false; seen.add(v);
    for (const x of v.props.values()) { if (x instanceof Ref) return true; if ((x instanceof PHPArray || x instanceof PHPObject) && containsRefSlot(x, seen)) return true; }
  }
  return false;
}
function runDestructor(o) {
  if (o.destructed) return;
  o.destructed = true;
  const i = rt.destructibles.indexOf(o);
  if (i >= 0) rt.destructibles.splice(i, 1);
  const m = o.cls.methods.get('__destruct');
  if (m) callFunction(m.fn, [], o, m.cls, o.cls, null);
}
function gcCollect(list, extra) {
  const cands = new Set(list.filter((o) => !o.destructed));
  if (!cands.size) return [];
  const seen = gcTraverse(cands, extra, false);
  const survivors = [];
  for (const o of cands) { if (seen.has(o)) survivors.push(o); else runDestructor(o); }
  return survivors;
}
function gcCheck(old) { // called when a reference to `old` is dropped
  if (old instanceof PHPObject && old.cls.hasDestructor && !old.destructed && !rt.inShutdown) gcCollect([old], null);
}
function gcAfterCall(f, ret) {
  const list = f.destr; f.destr = null;
  const survivors = gcCollect(list, [ret]);
  if (survivors.length) {
    const caller = rt.frame;
    if (caller && caller !== rt.globalFrame) { if (!caller.destr) caller.destr = []; for (const o of survivors) caller.destr.push(o); }
  }
}
function gcShutdown() {
  rt.inShutdown = true;
  // pass 1: globals in reverse order holding the only reference to an object
  for (let guard = 0; guard < 100; guard++) {
    if (!rt.destructibles.length) return;
    const counts = gcTraverse(null, null, true);
    let changed = false;
    const names = Object.keys(rt.globals).reverse();
    for (const k of names) {
      const r = rt.globals[k];
      if (!r) continue;
      const v = r.v;
      if (v instanceof PHPObject && v.cls.hasDestructor && !v.destructed && counts.get(v) === 1) { delete rt.globals[k]; runDestructor(v); changed = true; }
    }
    if (!changed) break;
  }
  // pass 2: remaining objects in creation order
  while (rt.destructibles.length) runDestructor(rt.destructibles[0]);
}

// ============================================================================
// Generators
// ============================================================================
class GenThrow { constructor(obj) { this.obj = obj; } }

function* genMain(fn, f) {
  if (!fn.genBody) compileBody(fn);
  const r = yield* fn.genBody(f);
  return r === RETURN ? f.ret : null;
}
class GenState {
  constructor(fn, f) {
    this.fn = fn; this.f = f; this.it = null; this.started = false; this.done = false; this.running = false;
    this.key = null; this.cur = null; this.curRef = null; this.ret = null; this.autoKey = -1; this.advanced = false;
  }
  ensure() { if (!this.started) { this.started = true; this.it = genMain(this.fn, this.f); this.step(undefined); } }
  step(val) {
    if (this.running) throwError('Error', 'Cannot resume an already running generator');
    this.running = true;
    const prevFrame = rt.frame, prevFile = rt.file, prevLine = rt.line;
    rt.frame = this.f; rt.file = this.fn.file;
    this.f.callLine = prevLine; this.f.callFile = prevFile;
    rt.stack.push(this.f);
    let r;
    try { r = this.it.next(val); }
    catch (e) { this.done = true; this.cur = null; this.key = null; throw e; }
    finally { this.running = false; rt.stack.pop(); rt.frame = prevFrame; rt.file = prevFile; rt.line = prevLine; }
    if (r.done) { this.done = true; this.ret = r.value === undefined ? null : r.value; this.cur = null; this.key = null; this.curRef = null; }
    else {
      const y = r.value;
      const k = y[0];
      if (k === undefined) this.key = ++this.autoKey;
      else { this.key = k; if (!y[2] && typeof k === 'number' && k > this.autoKey) this.autoKey = k; }
      this.cur = y[1]; this.curRef = y[3] || null;
    }
  }
  next() { if (!this.started) { this.ensure(); } if (!this.done) { this.advanced = true; this.step(null); } }
  send(v) {
    if (!this.started) this.ensure();
    if (!this.done) { this.advanced = true; this.step(v); }
    return this.done ? null : this.cur;
  }
  throwIn(obj) {
    if (!this.started) this.ensure();
    if (this.done) throw new ThrowSig(obj);
    this.advanced = true;
    this.step(new GenThrow(obj));
    return this.done ? null : this.cur;
  }
}
function makeGenerator(fn, f) {
  const o = new PHPObject(generatorClass);
  o.gen = new GenState(fn, f);
  f.gen = o;
  return o;
}

// ============================================================================
// Includes & program execution
// ============================================================================
function compileSource(src, file) {
  let ast;
  try { ast = parsePHP(src, file); }
  catch (e) {
    if (e instanceof ParseErr) throw new FatalSig(e.msg, e.line, file, e.kind || 'Parse error');
    throw e;
  }
  return { ast, body: null, file };
}
function hoistDecls(ast, f) {
  const fns = [], classes = [];
  const scan = (list) => {
    for (const s of list) {
      if (!s) continue;
      if (s.k === 'FuncDecl') fns.push(s);
      else if (s.k === 'ClassDecl') classes.push(s);
      else if (s.k === 'Block' && s.top) scan(s.body);
    }
  };
  scan(ast);
  for (const s of fns) { declareFunction(s.fn); s.hoisted = true; }
  // declare classes whose dependencies are available, repeat until fixpoint
  let progress = true;
  const pending = classes.filter((c) => !c.declared);
  while (progress && pending.length) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      const deps = [c.parent, ...c.interfaces, ...c.traits.flatMap((t) => t.names)].filter(Boolean);
      if (deps.every((d) => rt.classes.has(d.toLowerCase()))) {
        if (rt.classes.has(c.name.toLowerCase())) { pending.splice(i--, 1); continue; }
        declareClass(c, f);
        pending.splice(i--, 1);
        progress = true;
      }
    }
  }
}
function runProgram(prog, f) {
  if (!prog.body) prog.body = cStmts(prog.ast);
  hoistDecls(prog.ast, f);
  const r = prog.body(f);
  return r === RETURN ? f.ret : 1;
}

function resolveIncludePath(p) {
  if (p === '') return null;
  const tryFile = (x) => { try { return fs.statSync(x).isFile() ? x : null; } catch (e) { return null; } };
  if (pathMod.isAbsolute(p)) return tryFile(p);
  if (p.startsWith('./') || p.startsWith('../')) return tryFile(pathMod.resolve(process.cwd(), p));
  const inc = (rt.ini.get('include_path') || '.').split(':');
  for (const d of inc) { const r = tryFile(pathMod.resolve(process.cwd(), d, p)); if (r) return r; }
  if (rt.file) { const r = tryFile(pathMod.resolve(pathMod.dirname(rt.file), p)); if (r) return r; }
  return null;
}
const evalCache = new Map();
function doEval(code, f, st) {
  const file = `${rt.file}(${rt.line}) : eval()'d code`;
  const key = file + '\0' + code;
  let prog = evalCache.get(key);
  if (!prog) {
    let ast;
    try {
      const toks = lex('<?php ' + code, file);
      const p = new Parser(toks, file, Object.assign({ fnStack: [], clsStack: [], anonCount: 0, strict: false }, st));
      ast = p.parseProgram();
    } catch (e) {
      if (!(e instanceof ParseErr)) throw e;
      const ex = makeException('ParseError', e.msg);
      ex.props.set('file', file); ex.props.set('line', e.line);
      throw new ThrowSig(ex);
    }
    prog = { ast, body: cStmts(ast), file };
    if (evalCache.size > 1000) evalCache.clear();
    evalCache.set(key, prog);
  }
  const prevFile = rt.file, prevLine = rt.line;
  rt.file = file;
  try {
    hoistDecls(prog.ast, f);
    const r = prog.body(f);
    return r === RETURN ? f.ret : null;
  } finally { rt.file = prevFile; rt.line = prevLine; }
}
function doInclude(path, kind, f) {
  const resolved = resolveIncludePath(path);
  if (!resolved) {
    if (kind.startsWith('require')) {
      warn(`${kind}(${path}): Failed to open stream: No such file or directory`);
      throwError('Error', `Failed opening required '${path}' (include_path='${rt.ini.get('include_path') || '.:/usr/share/php'}')`);
    }
    warn(`${kind}(${path}): Failed to open stream: No such file or directory`);
    warn(`${kind}(): Failed opening '${path}' for inclusion (include_path='${rt.ini.get('include_path') || '.:/usr/share/php'}')`);
    return false;
  }
  const real = fs.realpathSync(resolved);
  if (kind.endsWith('_once') && rt.included.has(real)) return true;
  rt.included.add(real);
  let prog = rt.progCache.get(real);
  if (!prog) { prog = compileSource(fs.readFileSync(real, 'latin1'), real); rt.progCache.set(real, prog); }
  const prevFile = rt.file, prevLine = rt.line;
  const nf = new NativeFrame({ name: kind, isMethod: false }, [real]); nf.native = false;
  rt.stack.push(nf);
  rt.file = real;
  try { return runProgram(prog, f); }
  finally { rt.file = prevFile; rt.line = prevLine; rt.stack.pop(); }
}

// ============================================================================
// Builtin function library
// ============================================================================
function pnamesOf(fn) {
  const src = fn.toString();
  const m = /^[^(]*\(([^)]*)\)/.exec(src);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^\.\.\./, '').replace(/\s*=.*$/, '')).filter(Boolean).map((n) => n.replace(/^_/, ''));
}
function def(name, fn, opts) {
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
function alias(newName, old) { const e = rt.fns.get(old.toLowerCase()); rt.fns.set(newName.toLowerCase(), Object.assign(Object.create(Object.getPrototypeOf(e)), e, { name: newName })); }

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
function argPos(v) {
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
const S = (v) => {
  if (typeof v === 'string') return v;
  if (v === null) { nullArgDeprecation('string'); return ''; }
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPArray) argTypeErr('string', v);
  if (v instanceof PHPObject && !findMethod(v.cls, '__tostring')) argTypeErr('string', v);
  return toStr(v);
};
const I = (v) => {
  if (typeof v === 'number') return v;
  if (v === null) { nullArgDeprecation('int'); return 0; }
  if (v instanceof Flt) {
    if (!isFinite(v.v) || v.v >= 9223372036854775808 || v.v < -9223372036854775808) argTypeErr('int', v);
    if (!Number.isInteger(v.v)) deprecated(`Implicit conversion from float ${fmtRepr(v.v)} to int loses precision`);
    return floatToInt(v.v);
  }
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPArray || v instanceof PHPObject) argTypeErr('int', v);
  if (typeof v === 'string') { const n = numericStr(v); if (n === null) { const m = NUM_LEAD.exec(v); if (!m) argTypeErr('int', v); } }
  return toInt(v);
};
const N = (v) => { // JS number from int|float param
  if (typeof v === 'number') return v;
  if (v instanceof Flt) return v.v;
  if (v === null) { nullArgDeprecation('int|float'); return 0; }
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPArray || v instanceof PHPObject) argTypeErr('int|float', v);
  if (typeof v === 'string' && numericStr(v) === null && !NUM_LEAD.test(v)) argTypeErr('int|float', v);
  return toDbl(v);
};
const B = (v) => toBool(v instanceof Ref ? v.v : v);
const A = (v) => {
  if (v instanceof PHPArray) return v;
  if (v instanceof Ref) v = v.v;
  if (!(v instanceof PHPArray)) argTypeErr('array', v);
  return v;
};
const IntN = (v) => { if (isNum(v)) return v; if (v === null) { nullArgDeprecation('int|float'); return 0; } if (v instanceof PHPArray || v instanceof PHPObject) argTypeErr('int|float', v); return toNumber(v); }; // keep int|float
const F = (x) => mkf(x);
function numOut(x) { return Number.isInteger(x) && Math.abs(x) <= MAXS ? x : mkf(x); }
function deref(v) { return v instanceof Ref ? v.v : v; }
// copy an array slot into a new array: shared references stay references (like ZVAL_COPY)
function slotCp(x) { if (x instanceof Ref) return x._weak ? cp(x.v) : x; return cp(x); }
function refArr(ref) { return writableArrIn(ref); }

// ---------------------------------------------------------------- dumping
function varDump(v, ind, seen, rc) {
  const pad = ' '.repeat(ind);
  let amp = '';
  if (v instanceof Ref) { if (rc && (rc.get(v) || 0) > 1) amp = '&'; v = v.v; }
  if (amp) return varDump0(v, ind, seen, rc).replace(/^(\s*)/, '$1&');
  return varDump0(v, ind, seen, rc);
}
function varDump0(v, ind, seen, rc) {
  const pad = ' '.repeat(ind);
  if (v === null || v === undefined) return pad + 'NULL\n';
  switch (typeof v) {
    case 'boolean': return pad + `bool(${v})\n`;
    case 'number': case 'bigint': return pad + `int(${v})\n`;
    case 'string': return pad + `string(${v.length}) "${v}"\n`;
  }
  if (v instanceof Flt) return pad + `float(${fmtRepr(v.v)})\n`;
  if (v instanceof PHPArray) {
    if (seen.has(v)) return pad + '*RECURSION*\n';
    seen.add(v);
    let s = pad + `array(${v.size}) {\n`;
    for (const [k, x] of v.rawEntries()) s += pad + `  [${typeof k === 'string' ? '"' + k + '"' : k}]=>\n` + varDump(x, ind + 2, seen, rc);
    seen.delete(v);
    return s + pad + '}\n';
  }
  if (v instanceof PHPObject) {
    if (v.cls.isEnum) return pad + `enum(${v.cls.name}::${v.props.get('name')})\n`;
    if (seen.has(v)) return pad + '*RECURSION*\n';
    seen.add(v);
    const entries = debugProps(v);
    let s = pad + `object(${v.cls.anon ? displayName(v.cls) : v.cls.name})#${v.id} (${entries.length}) {\n`;
    for (const [label, x, uninit] of entries) {
      s += pad + `  [${label}]=>\n`;
      s += uninit ? pad + `  uninitialized(${uninit})\n` : varDump(x, ind + 2, seen, rc);
    }
    seen.delete(v);
    return s + pad + '}\n';
  }
  if (v instanceof PHPResource) return pad + `resource(${v.id}) of type (${v.closed ? 'Unknown' : v.type})\n`;
  return pad + 'NULL\n';
}
// [label, value, uninitializedType] for var_dump
function debugInfo(o) {
  const m = o.cls.methods.get('__debuginfo');
  if (!m) return null;
  const r = callFunction(m.fn, [], o, m.cls, o.cls, null);
  if (r === null) return new PHPArray();
  if (!(r instanceof PHPArray)) throw new FatalSig('__debuginfo() must return an array');
  return r;
}
function debugProps(o) {
  if (o.cls.nativeDebug) return o.cls.nativeDebug(o).map(([k, v]) => [typeof k === 'string' ? `"${k}"` : String(k), v]);
  const di = debugInfo(o);
  if (di) return di.rawEntries().map(([k, v]) => [typeof k === 'string' ? propLabel(o, k, true) : String(k), v]);
  const out = [];
  const seenKeys = new Set();
  for (const [key, info] of o.cls.slots) {
    if (!o.props.has(key) && info.type) { out.push([propLabel(o, key, true), null, typeStr(info.type)]); seenKeys.add(key); }
  }
  const res = [];
  for (const [k, s] of o.props) res.push([propLabel(o, k, true), s]);
  // order: declared slots first in declaration order, uninitialized shown in place
  if (out.length) {
    const ordered = [];
    for (const [key] of o.cls.slots) {
      if (o.props.has(key)) ordered.push([propLabel(o, key, true), o.props.get(key)]);
      else if (seenKeys.has(key)) ordered.push(out.find((x) => x[0] === propLabel(o, key, true)));
    }
    for (const [k, s] of o.props) if (!o.cls.slots.has(k)) ordered.push([propLabel(o, k, true), s]);
    return ordered;
  }
  return res;
}
function propLabel(o, key, dump) {
  if (key.charCodeAt(0) === 0) {
    const p = key.indexOf('\0', 1);
    const owner = key.slice(1, p), name = key.slice(p + 1);
    if (owner === '*') return dump ? `"${name}":protected` : `${name}:protected`;
    return dump ? `"${name}":"${owner}":private` : `${name}:${owner}:private`;
  }
  const info = o.cls.props.get(key);
  if (info && info.vis === 'protected') return dump ? `"${key}":protected` : `${key}:protected`;
  return dump ? (/^\d+$/.test(key) && false ? key : `"${key}"`) : key;
}

function printR(v, ind, seen) {
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPArray || (v instanceof PHPObject && !v.cls.isEnumX)) {
    const isArr = v instanceof PHPArray;
    if (seen.has(v)) return isArr ? 'Array\n *RECURSION*' : `${v.cls.name} Object\n *RECURSION*`;
    seen.add(v);
    const pad = ' '.repeat(ind);
    let s;
    let entries;
    if (isArr) { s = 'Array\n'; entries = v.entries().map(([k, x]) => [String(k), x]); }
    else {
      s = v.cls.isEnum ? `${v.cls.name} Enum${v.cls.enumBacked ? ':' + v.cls.enumBacked : ''}\n` : `${v.cls.anon ? displayName(v.cls) : v.cls.name} Object\n`;
      const di = v.cls.nativeDebug ? null : debugInfo(v);
      if (v.cls.nativeDebug) entries = v.cls.nativeDebug(v).map(([k, x]) => [String(k), x]);
      else if (di) entries = di.entries().map(([k, x]) => [typeof k === 'string' ? propLabel(v, k, false) : String(k), x]);
      else entries = [...v.props].map(([k, x]) => [propLabel(v, k, false), deref(x)]);
    }
    s += pad + '(\n';
    for (const [k, x] of entries) s += pad + `    [${k}] => ` + printR(x, ind + 8, seen) + '\n';
    s += pad + ')\n';
    seen.delete(v);
    return s;
  }
  return toStr(v);
}

function exportStr(s) {
  let out = "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (s.includes('\0')) out = out.split('\0').join('\' . "\\0" . \'');
  return out;
}
function varExport(v, ind, seen) {
  if (v instanceof Ref) v = v.v;
  const pad = ' '.repeat(ind);
  if (v === null || v === undefined) return 'NULL';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number': case 'bigint': return String(v);
    case 'string': return exportStr(v);
  }
  if (v instanceof Flt) return fmtReprZ(v.v);
  if (v instanceof PHPArray) {
    if (seen.has(v)) { warn('var_export does not handle circular references'); return 'NULL'; }
    seen.add(v);
    let s = 'array (\n';
    for (const [k, x] of v.entries()) {
      s += pad + '  ' + (typeof k === 'string' ? exportStr(k) : k) + ' => ';
      if ((x instanceof PHPArray) || (x instanceof PHPObject && !x.cls.isEnum)) s += '\n' + pad + '  ' + varExport(x, ind + 2, seen);
      else s += varExport(x, ind + 2, seen);
      s += ',\n';
    }
    seen.delete(v);
    return s + pad + ')';
  }
  if (v instanceof PHPObject) {
    if (v.cls.isEnum) return '\\' + v.cls.name + '::' + v.props.get('name');
    if (seen.has(v)) { warn('var_export does not handle circular references'); return 'NULL'; }
    seen.add(v);
    const isStd = v.cls.lname === 'stdclass';
    let s = isStd ? '(object) array(\n' : '\\' + v.cls.name + '::__set_state(array(\n';
    for (const [k, x0] of v.props) {
      const x = deref(x0);
      const name = k.charCodeAt(0) === 0 ? k.slice(k.indexOf('\0', 1) + 1) : k;
      s += pad + '   ' + exportStr(name) + ' => ';
      if ((x instanceof PHPArray) || (x instanceof PHPObject && !x.cls.isEnum)) s += '\n' + pad + '  ' + varExport(x, ind + 2, seen);
      else s += varExport(x, ind + 2, seen);
      s += ',\n';
    }
    seen.delete(v);
    return s + pad + (isStd ? ')' : '))');
  }
  return 'NULL';
}

def('var_dump', (...vals) => {
  for (const v of vals) {
    const rc = containsRefSlot(v, new Set()) ? refHolderCounts([v]) : null;
    rt.echo(varDump(v, 0, new Set(), rc));
  }
}, { min: 1 });
def('print_r', (value, _return = false) => { const s = printR(value, 0, new Set()); if (toBool(_return)) return s; rt.echo(s); return true; });
def('var_export', (value, _return = false) => { const s = varExport(value, 0, new Set()); if (toBool(_return)) return s; rt.echo(s); return null; });
def('debug_zval_refcount', () => 1);

// ---------------------------------------------------------------- printf family
function phpSprintf(fmt, args) {
  let out = '', ai = 0;
  const n = fmt.length;
  for (let i = 0; i < n; i++) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    i++;
    if (fmt[i] === '%') { out += '%'; continue; }
    let argIdx = null;
    let m = /^(\d+)\$/.exec(fmt.slice(i, i + 12));
    if (m) { argIdx = parseInt(m[1], 10) - 1; if (argIdx < 0) throwError('ValueError', 'Argument number specifier must be greater than zero and less than 2147483647'); i += m[0].length; }
    let left = false, plus = false, pad = ' ';
    for (;;) {
      const ch = fmt[i];
      if (ch === '-') left = true;
      else if (ch === '+') plus = true;
      else if (ch === '0') pad = '0';
      else if (ch === ' ') pad = ' ';
      else if (ch === "'") { pad = fmt[i + 1]; i++; }
      else break;
      i++;
    }
    let width = 0;
    m = /^\d+/.exec(fmt.slice(i, i + 12));
    if (m) { width = parseInt(m[0], 10); i += m[0].length; }
    else if (fmt[i] === '*') { width = toInt(args[ai++]); i++; }
    let prec = null;
    if (fmt[i] === '.') {
      i++;
      m = /^\d+/.exec(fmt.slice(i, i + 12));
      if (m) { prec = parseInt(m[0], 10); i += m[0].length; } else if (fmt[i] === '*') { prec = toInt(args[ai++]); i++; } else prec = 0;
    }
    if (fmt[i] === 'l') i++;
    const spec = fmt[i];
    if (spec === undefined) throwError('ValueError', 'Missing format specifier at end of string');
    const idx = argIdx !== null ? argIdx : ai++;
    if (idx >= args.length) {
      if (argIdx !== null) throwError('ArgumentCountError', `${args.length + 1} arguments are required, ${args.length + 1 - (idx - args.length + 1) < 0 ? 0 : args.length + 1} given`);
      throwError('ArgumentCountError', `${idx + 2} arguments are required, ${args.length + 1} given`);
    }
    let arg = args[idx];
    if (arg instanceof Ref) arg = arg.v;
    let s, numeric = false, signStr = '';
    switch (spec) {
      case 'd': case 'i': {
        const v = toInt(arg);
        const negv = v < 0;
        s = (negv ? (typeof v === 'bigint' ? (-v).toString() : String(-v)) : String(v));
        signStr = negv ? '-' : (plus ? '+' : '');
        numeric = true; break;
      }
      case 'u': { let v = toInt(arg); if (v < 0) v = BigInt.asUintN(64, BigInt(v)); s = v.toString(); numeric = true; break; }
      case 'f': case 'F': {
        const x = toDbl(arg);
        const p = prec === null ? 6 : Math.min(prec, 53);
        if (!isFinite(x)) { s = x !== x ? 'NaN' : (x > 0 ? 'Inf' : '-Inf'); if (x < 0) { s = 'Inf'; signStr = '-'; } }
        else { s = fixedStr(Math.abs(x), p); signStr = (x < 0 || (x === 0 && 1 / x < 0 && false)) ? '-' : (plus ? '+' : ''); if (x < 0 && /^[0.]*$/.test(s)) signStr = '-'; }
        numeric = true; break;
      }
      case 'e': case 'E': {
        const x = toDbl(arg);
        const p = prec === null ? 6 : prec;
        s = Math.abs(x).toExponential(Math.min(p, 100));
        if (spec === 'E') s = s.toUpperCase();
        signStr = x < 0 ? '-' : (plus ? '+' : '');
        numeric = true; break;
      }
      case 'g': case 'G': {
        const x = toDbl(arg);
        let p = prec === null ? 6 : prec; if (p === 0) p = 1;
        s = fmtFloat(Math.abs(x), p);
        if (spec === 'g') s = s.replace('E', 'e');
        signStr = x < 0 ? '-' : (plus ? '+' : '');
        numeric = true; break;
      }
      case 's': { s = toStr(arg); if (prec !== null) s = s.slice(0, prec); break; }
      case 'x': case 'X': case 'o': case 'b': {
        let v = toInt(arg);
        if (v < 0) v = BigInt.asUintN(64, BigInt(v));
        s = v.toString(spec === 'o' ? 8 : spec === 'b' ? 2 : 16);
        if (spec === 'X') s = s.toUpperCase();
        break;
      }
      case 'c': s = String.fromCharCode(toInt(arg) & 255); out += s; continue;
      default: throwError('ValueError', `Unknown format specifier "${spec}"`);
    }
    let full = signStr + s;
    if (width > full.length) {
      if (left) full = full + (pad === '0' ? '0' : pad).repeat(width - full.length);
      else if (pad === '0' && numeric) full = signStr + '0'.repeat(width - full.length) + s;
      else full = pad.repeat(width - full.length) + full;
    }
    out += full;
  }
  return out;
}
function fixedStr(x, p) { // x >= 0
  if (x < 1e21) {
    // correct rounding of the binary value; exact ties round half-to-even (zend_dtoa mode 3)
    const s = x.toFixed(p);
    const ext = x.toFixed(Math.min(100, p + 25));
    const dot = ext.indexOf('.');
    const tail = ext.slice(dot + 1 + p);
    if (tail[0] === '5' && /^50*$/.test(tail)) {
      const trunc = p === 0 ? ext.slice(0, dot) : ext.slice(0, dot + 1 + p);
      const last = trunc.charCodeAt(trunc.length - 1) - 48;
      if (last % 2 === 0) return trunc;
    }
    return s;
  }
  let s = BigInt(Math.round(x)).toString();
  return p > 0 ? s + '.' + '0'.repeat(p) : s;
}
def('sprintf', (format, ...values) => phpSprintf(S(format), values));
def('vsprintf', (format, values) => phpSprintf(S(format), A(values).values()));
def('printf', (format, ...values) => { const s = phpSprintf(S(format), values); rt.echo(s); return s.length; });
def('vprintf', (format, values) => { const s = phpSprintf(S(format), A(values).values()); rt.echo(s); return s.length; });
def('fprintf', (stream, format, ...values) => { const s = phpSprintf(S(format), values); streamWrite(stream, s); return s.length; });
def('vfprintf', (stream, format, values) => { const s = phpSprintf(S(format), A(values).values()); streamWrite(stream, s); return s.length; });

function phpRound(x, places, mode) {
  if (!isFinite(x) || x === 0) return x;
  places = places | 0;
  const neg = x < 0; const ax = Math.abs(x);
  const e = ax.toExponential(14); // 15 significant digits (PHP pre-rounding)
  const [mant, expS] = e.split('e');
  const digits = mant.replace('.', '');
  const exp = parseInt(expS, 10);
  const keep = exp + 1 + places; // number of digits to keep
  if (keep >= 15) return x;
  if (keep < 0) return neg ? -0 : 0;
  const head = digits.slice(0, keep);
  const nextD = digits.charCodeAt(keep) - 48;
  const rest = digits.slice(keep + 1);
  let up;
  mode = mode || 1;
  const restNonZero = /[1-9]/.test(rest);
  switch (mode) {
    case 2: up = nextD > 5 || (nextD === 5 && restNonZero); break; // HALF_DOWN
    case 3: up = nextD > 5 || (nextD === 5 && (restNonZero || (head.length ? (head.charCodeAt(head.length - 1) - 48) % 2 === 1 : false))); break; // HALF_EVEN
    case 4: up = nextD > 5 || (nextD === 5 && (restNonZero || (head.length ? (head.charCodeAt(head.length - 1) - 48) % 2 === 0 : true))); break; // HALF_ODD
    default: up = nextD >= 5;
  }
  let numStr = head || '0';
  let val = BigInt(numStr) + (up ? 1n : 0n);
  // value = val * 10^(exp + 1 - keep)
  const scale = exp + 1 - keep;
  const r = Number(val.toString() + 'e' + scale);
  return neg ? -r : r;
}
function numberFormat(x, dec, dp, ts) {
  let r = phpRound(x, dec);
  dec = Math.max(0, dec);
  const neg = r < 0;
  let s = Math.abs(r).toFixed(Math.min(dec, 100));
  if (dec > 100) s += '0'.repeat(dec - 100);
  if (Math.abs(r) >= 1e21) s = BigInt(Math.round(Math.abs(r))).toString() + (dec ? '.' + '0'.repeat(dec) : '');
  let [ip, fp] = s.split('.');
  ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ts);
  let out = ip + (dec > 0 ? dp + fp : '');
  if (neg && /[1-9]/.test(s)) out = '-' + out;
  return out;
}
def('number_format', (num, decimals = 0, decimal_separator = '.', thousands_separator = ',') => numberFormat(N(num), I(decimals), decimal_separator === null ? '.' : S(decimal_separator), thousands_separator === null ? ',' : S(thousands_separator)));

// ---------------------------------------------------------------- strings
const lower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const upper = (s) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());
def('strlen', (string) => S(string).length);
def('strtolower', (string) => lower(S(string)));
def('strtoupper', (string) => upper(S(string)));
def('ucfirst', (string) => { const s = S(string); return s ? upper(s[0]) + s.slice(1) : s; });
def('lcfirst', (string) => { const s = S(string); return s ? lower(s[0]) + s.slice(1) : s; });
def('ucwords', (string, separators = ' \t\r\n\f\v') => {
  const s = S(string), seps = S(separators);
  let out = '', cap = true;
  for (const ch of s) { out += cap ? upper(ch) : ch; cap = seps.includes(ch); }
  return out;
});
function trimChars(chars) {
  // supports ranges a..z
  let set = '';
  for (let i = 0; i < chars.length; i++) {
    if (chars[i + 1] === '.' && chars[i + 2] === '.' && i + 3 < chars.length) {
      const a = chars.charCodeAt(i), b = chars.charCodeAt(i + 3);
      for (let c = a; c <= b; c++) set += String.fromCharCode(c);
      i += 3;
    } else set += chars[i];
  }
  return set;
}
function phpTrim(s, chars, mode) {
  const set = chars === undefined ? ' \t\n\r\0\x0B' : trimChars(chars);
  let a = 0, b = s.length;
  if (mode & 1) while (a < b && set.includes(s[a])) a++;
  if (mode & 2) while (b > a && set.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
def('trim', (string, characters = undefined) => phpTrim(S(string), characters === undefined ? undefined : S(characters), 3));
def('ltrim', (string, characters = undefined) => phpTrim(S(string), characters === undefined ? undefined : S(characters), 1));
def('rtrim', (string, characters = undefined) => phpTrim(S(string), characters === undefined ? undefined : S(characters), 2));
alias('chop', 'rtrim');
def('str_repeat', (string, times) => { const n = I(times); if (n < 0) throwError('ValueError', 'str_repeat(): Argument #2 ($times) must be greater than or equal to 0'); return S(string).repeat(n); });
def('strrev', (string) => S(string).split('').reverse().join(''));
def('str_pad', (string, length, pad_string = ' ', pad_type = 1) => {
  const s = S(string), len = I(length), pad = S(pad_string), type = I(pad_type);
  if (pad === '') throwError('ValueError', 'str_pad(): Argument #3 ($pad_string) must be a non-empty string');
  if (len <= s.length) return s;
  const total = len - s.length;
  const mk = (n) => pad.repeat(Math.ceil(n / pad.length)).slice(0, n);
  if (type === 0) return mk(total) + s;
  if (type === 2) { const l = Math.floor(total / 2); return mk(l) + s + mk(total - l); }
  return s + mk(total);
});
function substrImpl(s, start, len) {
  const n = s.length;
  if (start < 0) start = Math.max(0, n + start);
  if (start > n) return '';
  let end;
  if (len === null || len === undefined) end = n;
  else if (len < 0) end = n + len;
  else end = start + len;
  if (end < start) return '';
  return s.slice(start, end);
}
def('substr', (string, offset, length = null) => substrImpl(S(string), I(offset), length === null ? null : I(length)));
def('substr_count', (haystack, needle, offset = 0, length = null) => {
  let h = S(haystack); const nd = S(needle);
  if (nd === '') throwError('ValueError', 'substr_count(): Argument #2 ($needle) cannot be empty');
  h = substrImpl(h, I(offset), length === null ? null : I(length));
  let c = 0, p = 0;
  while ((p = h.indexOf(nd, p)) >= 0) { c++; p += nd.length; }
  return c;
});
function posArgs(h, off) {
  if (off < 0) off += h.length;
  if (off < 0 || off > h.length) throwError('ValueError', `${rt.nativeName}(): Argument #3 ($offset) must be contained in argument #1 ($haystack)`);
  return off;
}
def('strpos', (haystack, needle, offset = 0) => { const h = S(haystack); const r = h.indexOf(S(needle), posArgs(h, I(offset))); return r < 0 ? false : r; });
def('stripos', (haystack, needle, offset = 0) => { const h = lower(S(haystack)); const r = h.indexOf(lower(S(needle)), posArgs(h, I(offset))); return r < 0 ? false : r; });
function strrposImpl(h, nd, off) {
  let r;
  if (off >= 0) { if (off > h.length) throwError('ValueError', `${rt.nativeName}(): Argument #3 ($offset) must be contained in argument #1 ($haystack)`); r = h.lastIndexOf(nd); if (r < off) r = -1; }
  else { if (-off > h.length) throwError('ValueError', `${rt.nativeName}(): Argument #3 ($offset) must be contained in argument #1 ($haystack)`); r = h.lastIndexOf(nd, h.length + off); }
  return r < 0 ? false : r;
}
def('strrpos', (haystack, needle, offset = 0) => strrposImpl(S(haystack), S(needle), I(offset)));
def('strripos', (haystack, needle, offset = 0) => strrposImpl(lower(S(haystack)), lower(S(needle)), I(offset)));
def('str_contains', (haystack, needle) => S(haystack).includes(S(needle)));
def('str_starts_with', (haystack, needle) => S(haystack).startsWith(S(needle)));
def('str_ends_with', (haystack, needle) => S(haystack).endsWith(S(needle)));
def('strstr', (haystack, needle, before_needle = false) => { const h = S(haystack); const p = h.indexOf(S(needle)); if (p < 0) return false; return toBool(before_needle) ? h.slice(0, p) : h.slice(p); });
alias('strchr', 'strstr');
def('stristr', (haystack, needle, before_needle = false) => { const h = S(haystack); const p = lower(h).indexOf(lower(S(needle))); if (p < 0) return false; return toBool(before_needle) ? h.slice(0, p) : h.slice(p); });
def('strrchr', (haystack, needle) => { const h = S(haystack); let nd = S(needle); if (!nd) return false; const p = h.lastIndexOf(nd[0]); return p < 0 ? false : h.slice(p); });
def('strpbrk', (string, characters) => { const s = S(string), cs = S(characters); for (let i = 0; i < s.length; i++) if (cs.includes(s[i])) return s.slice(i); return false; });
def('strspn', (string, characters, offset = 0, length = null) => { const s = substrImpl(S(string), I(offset), length === null ? null : I(length)), cs = S(characters); let i = 0; while (i < s.length && cs.includes(s[i])) i++; return i; });
def('strcspn', (string, characters, offset = 0, length = null) => { const s = substrImpl(S(string), I(offset), length === null ? null : I(length)), cs = S(characters); let i = 0; while (i < s.length && !cs.includes(s[i])) i++; return i; });
const sgn = (x) => (x < 0 ? -1 : x > 0 ? 1 : 0);
function byteCmp(a, b) {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) { const d = a.charCodeAt(i) - b.charCodeAt(i); if (d) return d; }
  return a.length - b.length;
}
def('strcmp', (string1, string2) => byteCmp(S(string1), S(string2)));
function caseDiff(a, b, n) {
  const la = Math.min(a.length, n), lb = Math.min(b.length, n);
  const m = Math.min(la, lb);
  for (let i = 0; i < m; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x >= 65 && x <= 90) x += 32; if (y >= 65 && y <= 90) y += 32;
    if (x !== y) return x - y;
  }
  return la - lb;
}
def('strcasecmp', (string1, string2) => caseDiff(S(string1), S(string2), Infinity));
def('strncmp', (string1, string2, length) => { const n = I(length); if (n < 0) throwError('ValueError', 'strncmp(): Argument #3 ($length) must be greater than or equal to 0'); return byteCmp(S(string1).slice(0, n), S(string2).slice(0, n)); });
def('strncasecmp', (string1, string2, length) => { const n = I(length); if (n < 0) throwError('ValueError', 'strncasecmp(): Argument #3 ($length) must be greater than or equal to 0'); return caseDiff(S(string1), S(string2), n); });
function natCmp(a, b, ci) {
  if (ci) { a = lower(a); b = lower(b); }
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a[i], cb = b[j];
    if (/\d/.test(ca) && /\d/.test(cb)) {
      let si = i; while (si < a.length && a[si] === '0') si++;
      let sj = j; while (sj < b.length && b[sj] === '0') sj++;
      let ei = si; while (ei < a.length && /\d/.test(a[ei])) ei++;
      let ej = sj; while (ej < b.length && /\d/.test(b[ej])) ej++;
      const na = a.slice(si, ei), nb = b.slice(sj, ej);
      if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
      if (na !== nb) return na < nb ? -1 : 1;
      i = ei; j = ej; continue;
    }
    if (/\s/.test(ca) && /\s/.test(cb)) { while (i < a.length && /\s/.test(a[i])) i++; while (j < b.length && /\s/.test(b[j])) j++; continue; }
    if (ca !== cb) return ca < cb ? -1 : 1;
    i++; j++;
  }
  return sgn((a.length - i) - (b.length - j));
}
def('strnatcmp', (string1, string2) => natCmp(S(string1), S(string2), false));
def('strnatcasecmp', (string1, string2) => natCmp(S(string1), S(string2), true));
def('substr_compare', (haystack, needle, offset, length = null, case_insensitive = false) => {
  let h = S(haystack); let nd = S(needle); let off = I(offset);
  if (off < 0) off = Math.max(0, h.length + off);
  if (off > h.length) throwError('ValueError', 'substr_compare(): Argument #3 ($offset) must be contained in argument #1 ($main_str)');
  let a = h.slice(off), b = nd;
  if (length !== null) { const l = I(length); a = a.slice(0, l); b = b.slice(0, l); }
  if (toBool(case_insensitive)) { a = lower(a); b = lower(b); }
  return byteCmp(a, b);
});
def('str_split', (string, length = 1) => {
  const s = S(string), n = I(length);
  if (n < 1) throwError('ValueError', 'str_split(): Argument #2 ($length) must be greater than 0');
  if (s === '') return PHPArray.from(['']);
  const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return PHPArray.from(out);
});
def('explode', (separator, string, limit = MAXS) => {
  const sep = S(separator), s = S(string); let lim = I(limit);
  if (sep === '') throwError('ValueError', 'explode(): Argument #1 ($separator) cannot be empty');
  let parts = s.split(sep);
  if (lim > 0 && parts.length > lim) parts = parts.slice(0, lim - 1).concat([parts.slice(lim - 1).join(sep)]);
  else if (lim < 0) parts = parts.slice(0, lim);
  else if (lim === 0 && parts.length > 1) parts = [parts.join(sep)];
  return PHPArray.from(parts);
});
def('implode', (separator, array) => {
  let sep = separator, arr = array;
  if (arr === undefined) { arr = sep; sep = ''; }
  if (sep instanceof PHPArray) { const t = sep; sep = arr; arr = t; }
  if (!(arr instanceof PHPArray)) throwError('TypeError', 'implode(): Argument #2 ($array) must be of type ?array, ' + typeOf(arr) + ' given');
  const s = S(sep === null ? '' : sep);
  const vals = arr.values();
  let out = '';
  for (let i = 0; i < vals.length; i++) { if (i) out += s; const v = vals[i]; out += typeof v === 'string' ? v : toStr(v); }
  return out;
}, { min: 1 });
alias('join', 'implode');
function strReplaceImpl(search, replace, subject, ci, countRef) {
  let count = 0;
  const one = (s) => {
    s = toStr(s);
    const searches = search instanceof PHPArray ? search.values().map(toStr) : [toStr(search)];
    const reps = replace instanceof PHPArray ? replace.values().map(toStr) : null;
    for (let i = 0; i < searches.length; i++) {
      const se = searches[i];
      if (se === '') continue;
      const rep = reps ? (i < reps.length ? reps[i] : '') : toStr(replace);
      if (!ci) {
        let idx = s.indexOf(se);
        if (idx < 0) continue;
        let out = '', last = 0;
        while (idx >= 0) { out += s.slice(last, idx) + rep; last = idx + se.length; count++; idx = s.indexOf(se, last); }
        s = out + s.slice(last);
      } else {
        const ls = lower(se);
        let low = lower(s), idx = low.indexOf(ls);
        if (idx < 0) continue;
        let out = '', last = 0;
        while (idx >= 0) { out += s.slice(last, idx) + rep; last = idx + se.length; count++; idx = low.indexOf(ls, last); }
        s = out + s.slice(last);
      }
    }
    return s;
  };
  let r;
  if (subject instanceof PHPArray) {
    r = new PHPArray();
    for (const [k, v] of subject.entries()) r.set(k, (v instanceof PHPArray) ? v : one(v));
  } else r = one(subject);
  if (countRef instanceof Ref) countRef.v = count;
  return r;
}
def('str_replace', (search, replace, subject, count = undefined) => strReplaceImpl(search, replace, subject, false, count), { refs: [false, false, false, true] });
def('str_ireplace', (search, replace, subject, count = undefined) => strReplaceImpl(search, replace, subject, true, count), { refs: [false, false, false, true] });
def('substr_replace', (string, replace, offset, length = null) => {
  const one = (s, rep, off, len) => {
    s = toStr(s); rep = toStr(rep); off = toInt(off);
    const n = s.length;
    if (off < 0) off = Math.max(0, n + off); if (off > n) off = n;
    let end;
    if (len === null || len === undefined) end = n; else { len = toInt(len); end = len < 0 ? Math.max(off, n + len) : Math.min(n, off + len); }
    return s.slice(0, off) + rep + s.slice(end);
  };
  if (string instanceof PHPArray) {
    const out = new PHPArray(); let i = 0;
    const pick = (v, idx) => (v instanceof PHPArray ? (v.values()[idx] !== undefined ? v.values()[idx] : (v === replace ? '' : null)) : v);
    for (const [k, v] of string.entries()) { out.set(k, one(v, pick(replace, i), pick(offset, i) ?? 0, length instanceof PHPArray ? pick(length, i) : length)); i++; }
    return out;
  }
  return one(string, replace instanceof PHPArray ? (replace.values()[0] ?? '') : replace, offset, length);
});
def('strtr', (string, from, to = undefined) => {
  const s = S(string);
  if (to === undefined) {
    const map = A(from);
    const pairs = map.entries().map(([k, v]) => [String(k), toStr(v)]).filter(([k]) => k !== '');
    if (!pairs.length) return s;
    pairs.sort((a, b) => b[0].length - a[0].length);
    const byFirst = new Map();
    for (const p of pairs) { const c = p[0][0]; if (!byFirst.has(c)) byFirst.set(c, []); byFirst.get(c).push(p); }
    let out = '';
    for (let i = 0; i < s.length;) {
      const cands = byFirst.get(s[i]);
      let hit = null;
      if (cands) for (const p of cands) if (s.startsWith(p[0], i)) { hit = p; break; }
      if (hit) { out += hit[1]; i += hit[0].length; } else { out += s[i]; i++; }
    }
    return out;
  }
  const f = S(from), t = S(to);
  const n = Math.min(f.length, t.length);
  if (!n) return s;
  const m = new Map(); for (let i = 0; i < n; i++) m.set(f[i], t[i]);
  let out = ''; for (const ch of s) out += m.has(ch) ? m.get(ch) : ch;
  return out;
});
def('nl2br', (string, use_xhtml = true) => S(string).replace(/(\r\n|\n\r|\n|\r)/g, (toBool(use_xhtml) ? '<br />' : '<br>') + '$1'));
const HTML_ESC = { '&': '&amp;', '"': '&quot;', "'": '&#039;', '<': '&lt;', '>': '&gt;' };
def('htmlspecialchars', (string, flags = 11, encoding = null, double_encode = true) => {
  const fl = I(flags);
  let s = S(string);
  if (htmlCharset(encoding) === 'utf-8') { s = fixUtf8(s, fl); if (s === null) return ''; }
  const de = toBool(double_encode);
  return s.replace(/[&"'<>]/g, (c, off) => {
    if (c === '"' && !(fl & 2)) return c;
    if (c === "'" && !(fl & 1)) return c;
    if (c === "'") return (fl & 16 || fl & 32) ? '&apos;' : '&#039;';
    if (c === '&' && !de && /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(s.slice(off, off + 12))) return c;
    return HTML_ESC[c];
  });
});
const HTML401_SRC = '160:nbsp,iexcl,cent,pound,curren,yen,brvbar,sect,uml,copy,ordf,laquo,not,shy,reg,macr,deg,plusmn,sup2,sup3,acute,micro,para,middot,cedil,sup1,ordm,raquo,frac14,frac12,frac34,iquest,Agrave,Aacute,Acirc,Atilde,Auml,Aring,AElig,Ccedil,Egrave,Eacute,Ecirc,Euml,Igrave,Iacute,Icirc,Iuml,ETH,Ntilde,Ograve,Oacute,Ocirc,Otilde,Ouml,times,Oslash,Ugrave,Uacute,Ucirc,Uuml,Yacute,THORN,szlig,agrave,aacute,acirc,atilde,auml,aring,aelig,ccedil,egrave,eacute,ecirc,euml,igrave,iacute,icirc,iuml,eth,ntilde,ograve,oacute,ocirc,otilde,ouml,divide,oslash,ugrave,uacute,ucirc,uuml,yacute,thorn,yuml;338:OElig,oelig;352:Scaron,scaron;376:Yuml;402:fnof;710:circ;732:tilde;913:Alpha,Beta,Gamma,Delta,Epsilon,Zeta,Eta,Theta,Iota,Kappa,Lambda,Mu,Nu,Xi,Omicron,Pi,Rho;931:Sigma,Tau,Upsilon,Phi,Chi,Psi,Omega;945:alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu,nu,xi,omicron,pi,rho,sigmaf,sigma,tau,upsilon,phi,chi,psi,omega;977:thetasym,upsih;982:piv;8194:ensp,emsp;8201:thinsp;8204:zwnj,zwj,lrm,rlm;8211:ndash,mdash;8216:lsquo,rsquo,sbquo;8220:ldquo,rdquo,bdquo;8224:dagger,Dagger,bull;8230:hellip;8240:permil;8242:prime,Prime;8249:lsaquo,rsaquo;8254:oline;8260:frasl;8364:euro;8465:image;8472:weierp;8476:real;8482:trade;8501:alefsym;8592:larr,uarr,rarr,darr,harr;8629:crarr;8656:lArr,uArr,rArr,dArr,hArr;8704:forall;8706:part,exist;8709:empty;8711:nabla,isin,notin;8715:ni;8719:prod;8721:sum,minus;8727:lowast;8730:radic;8733:prop,infin;8736:ang;8743:and,or,cap,cup,int;8756:there4;8764:sim;8773:cong;8776:asymp;8800:ne,equiv;8804:le,ge;8834:sub,sup,nsub;8838:sube,supe;8853:oplus;8855:otimes;8869:perp;8901:sdot;8968:lceil,rceil,lfloor,rfloor;9001:lang,rang;9674:loz;9824:spades;9827:clubs;9829:hearts,diams';
let HTML401 = null, html401Rev = null; // codepoint -> name
function html401() {
  if (HTML401) return HTML401;
  HTML401 = new Map();
  for (const run of HTML401_SRC.split(';')) {
    const [start, names] = run.split(':');
    let cp = parseInt(start, 10);
    for (const nm of names.split(',')) { if (cp === 930) cp++; HTML401.set(cp++, nm); }
  }
  // skip codepoints not in the runs: 8195->emsp handled by run order; fix gaps explicitly
  return HTML401;
}
const ENT_DECODE = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', euro: '€', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', trade: '™', deg: '°', times: '×', divide: '÷', middot: '·', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', plusmn: '±', frac12: '½', iexcl: '¡', iquest: '¿' };
def('htmlspecialchars_decode', (string, flags = 11) => {
  const fl = I(flags);
  return S(string).replace(/&(amp|lt|gt|quot|#0*39|#x0*27|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
    if (l === 'quot') return (fl & 2) ? '"' : m;
    if (l === 'apos') return (fl & 16 || fl & 32) && (fl & 1) ? "'" : m;
    return (fl & 1) ? "'" : m;
  });
});
def('html_entity_decode', (string, flags = 11, encoding = null) => {
  const fl = I(flags);
  return S(string).replace(/&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (cp === 39 && !(fl & 1)) return m;
      if (cp === 34 && !(fl & 2)) return m;
      try { return utf8Encode(String.fromCodePoint(cp)); } catch (_) { return m; }
    }
    if (e === 'quot' && !(fl & 2)) return m;
    if (e === 'apos' && !(fl & 1)) return m;
    let d = ENT_DECODE[e];
    if (d === undefined) { if (!html401Rev) { html401Rev = new Map(); for (const [cp, nm] of html401()) html401Rev.set(nm, String.fromCodePoint(cp)); } d = html401Rev.get(e); }
    return d !== undefined ? utf8Encode(d) : m;
  });
});
function cp1252ToUnicode(c) {
  const t = { 0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178 };
  return t[c] || c;
}
function htmlCharset(encoding) {
  if (encoding === null || encoding === undefined || encoding === '') return 'utf-8';
  const e = toStr(encoding).toLowerCase();
  if (/^(iso-?8859-1|latin1)$/.test(e)) return 'latin1';
  if (/^(cp1252|windows-1252|1252)$/.test(e)) return 'cp1252';
  if (/^utf-?8$/.test(e)) return 'utf-8';
  warn(`${rt.nativeName}(): Charset "${toStr(encoding)}" is not supported, assuming UTF-8`);
  return 'utf-8';
}
function fixUtf8(s, fl) { // returns null when invalid and neither ENT_IGNORE nor ENT_SUBSTITUTE
  if (isValidUtf8(s)) return s;
  if (fl & 8) return utf8Encode(Buffer.from(s, 'latin1').toString('utf8'));
  if (fl & 4) return utf8Encode(Buffer.from(s, 'latin1').toString('utf8').replace(/�/g, ''));
  return null;
}
def('htmlentities', (string, flags = 11, encoding = null, double_encode = true) => {
  const fl = I(flags); const cs = htmlCharset(encoding); let str = S(string);
  if (cs === 'utf-8') { str = fixUtf8(str, fl); if (str === null) return ''; }
  const base = callNative(rt.fns.get('htmlspecialchars'), [str, fl, cs === 'utf-8' ? 'UTF-8' : 'ISO-8859-1', double_encode]);
  const tbl = html401();
  let out = '';
  if (cs === 'utf-8') {
    for (const ch of utf8Decode(base)) { const cp = ch.codePointAt(0); const nm = cp >= 160 ? tbl.get(cp) : undefined; out += nm ? '&' + nm + ';' : utf8Encode(ch); }
    return out;
  }
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i);
    if (c < 128) { out += base[i]; continue; }
    const cp = cs === 'cp1252' ? cp1252ToUnicode(c) : c;
    const nm = tbl.get(cp);
    out += nm ? '&' + nm + ';' : base[i];
  }
  return out;
});
def('get_html_translation_table', (table = 0, flags = 11, encoding = 'UTF-8') => {
  const fl = I(flags); const out = new PHPArray();
  const add = (ch, e) => out.set(ch, e);
  if (fl & 2) add('"', '&quot;');
  add('&', '&amp;');
  if (fl & 1) add("'", (fl & 16 || fl & 32) ? '&apos;' : '&#039;');
  add('<', '&lt;'); add('>', '&gt;');
  if (I(table) === 1) for (const [cp, nm] of html401()) add(utf8Encode(String.fromCodePoint(cp)), '&' + nm + ';');
  return out;
});
function stripTagFind(tag, allow) { // php_tag_find: normalize "<a href=..>" / "</a>" to "<a>"
  let norm = '', state = 0;
  for (let i = 0; i < tag.length; i++) {
    const c = tag[i].toLowerCase();
    if (c === '<') { norm += c; continue; }
    if (c === '>') break;
    if (!/\s/.test(c)) { if (state === 0) state = 1; if (c !== '/' || (tag[i - 1] !== '<' && tag[i + 1] !== '>')) norm += c; }
    else if (state === 1) break;
  }
  return allow.includes(norm + '>');
}
function stripTags(str, allow) {
  let out = '', tbuf = '', state = 0, depth = 0, inQ = '', lc = '', br = 0, isXml = false;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    const c = str[i], prev = i > 0 ? str[i - 1] : '', prev2 = i > 1 ? str[i - 2] : '';
    switch (c) {
      case '\0': break;
      case '<':
        if (inQ) break;
        if (/\s/.test(str[i + 1] || '') && !allow) { if (state === 0) out += c; break; }
        if (state === 0) { lc = '<'; state = 1; if (allow) tbuf = '<'; }
        else if (state === 1) depth++;
        break;
      case '(': case ')':
        if (state === 2) { if (lc !== '"' && lc !== "'") { lc = c; br += c === '(' ? 1 : -1; } }
        else if (allow && state === 1) tbuf += c;
        else if (state === 0) out += c;
        break;
      case '>':
        if (depth) { depth--; break; }
        if (inQ) break;
        switch (state) {
          case 1:
            lc = '>';
            if (isXml && prev === '-') break;
            inQ = ''; state = 0; isXml = false;
            if (allow) { tbuf += '>'; if (stripTagFind(tbuf, allow)) out += tbuf; tbuf = ''; }
            break;
          case 2: if (!br && lc !== '"' && prev === '?') { inQ = ''; state = 0; tbuf = ''; } break;
          case 3: inQ = ''; state = 0; tbuf = ''; break;
          case 4: if (prev === '-' && prev2 === '-') { inQ = ''; state = 0; tbuf = ''; } break;
          default: out += c;
        }
        break;
      case '"': case "'":
        if (state === 4) break;
        if (state === 2 && prev !== '\\') { if (lc === c) lc = ''; else if (lc !== '\\') lc = c; }
        else if (state === 0) out += c;
        else if (allow && state === 1) tbuf += c;
        if (state && prev !== '\\' && (!inQ || c === inQ)) inQ = inQ ? '' : c;
        break;
      case '!':
        if (state === 1 && prev === '<') { state = 3; lc = c; }
        else if (state === 0) out += c;
        else if (allow && state === 1) tbuf += c;
        break;
      case '-':
        if (state === 3 && prev === '-' && prev2 === '!') { state = 4; break; }
        if (state === 0) out += c; else if (allow && state === 1) tbuf += c;
        break;
      case '?':
        if (state === 1 && prev === '<') { br = 0; state = 2; break; }
        if (state === 0) out += c; else if (allow && state === 1) tbuf += c;
        break;
      case 'E': case 'e':
        if (state === 3 && i > 6 && str.slice(i - 6, i + 1).toLowerCase() === 'doctype') { state = 1; break; }
        if (state === 0) out += c; else if (allow && state === 1) tbuf += c;
        break;
      case 'l': case 'L':
        if (state === 2 && i > 2 && str.slice(i - 2, i).toLowerCase() === 'xm') { state = 1; isXml = true; break; }
        if (state === 0) out += c; else if (allow && state === 1) tbuf += c;
        break;
      default:
        if (state === 0) out += c; else if (allow && state === 1) tbuf += c;
    }
  }
  return out;
}
def('strip_tags', (string, allowed_tags = null) => {
  let allow = '';
  if (allowed_tags instanceof PHPArray) allow = allowed_tags.values().map((t) => '<' + toStr(t).toLowerCase() + '>').join('');
  else if (allowed_tags !== null) allow = S(allowed_tags).toLowerCase();
  return stripTags(S(string), allow);
});
def('addslashes', (string) => S(string).replace(/([\\'"])/g, '\\$1').replace(/\0/g, '\\0'));
def('stripslashes', (string) => S(string).replace(/\\(.?)/gs, (m, c) => (c === '0' ? '\0' : c)));
def('addcslashes', (string, characters) => {
  const set = trimChars(S(characters));
  return S(string).replace(/[\s\S]/g, (c) => {
    if (!set.includes(c)) return c;
    const code = c.charCodeAt(0);
    const map = { 10: 'n', 9: 't', 13: 'r', 7: 'a', 11: 'v', 8: 'b', 12: 'f' };
    if (map[code]) return '\\' + map[code];
    if (code < 32 || code > 126) return '\\' + code.toString(8).padStart(3, '0');
    return '\\' + c;
  });
});
def('stripcslashes', (string) => S(string).replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/gs, (m, e) => {
  const map = { n: '\n', t: '\t', r: '\r', a: '\x07', v: '\v', b: '\b', f: '\f' };
  if (map[e]) return map[e];
  if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
  if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 255);
  return e;
}));
def('quotemeta', (string) => S(string).replace(/([.\\+*?[^\]$()])/g, '\\$1'));
def('chr', (codepoint) => String.fromCharCode(((I(codepoint) % 256) + 256) % 256));
def('ord', (character) => { const s = S(character); return s.length ? s.charCodeAt(0) : 0; });
def('bin2hex', (string) => bytes(S(string)).toString('hex'));
def('hex2bin', (string) => { const s = S(string); if (s.length % 2) { warn('hex2bin(): Hexadecimal input string must have an even length'); return false; } if (!/^[0-9a-fA-F]*$/.test(s)) { warn('hex2bin(): Input string must be hexadecimal string'); return false; } return fromBytes(Buffer.from(s, 'hex')); });
def('dechex', (num) => { let v = I(num); if (v < 0) v = BigInt.asUintN(64, BigInt(v)); return v.toString(16); });
def('decbin', (num) => { let v = I(num); if (v < 0) v = BigInt.asUintN(64, BigInt(v)); return v.toString(2); });
def('decoct', (num) => { let v = I(num); if (v < 0) v = BigInt.asUintN(64, BigInt(v)); return v.toString(8); });
function baseToDec(s, base) {
  s = toStr(s).toLowerCase().replace(base === 16 ? /^0x/ : base === 8 ? /^0o/ : base === 2 ? /^0b/ : /^$/, '');
  let r = 0n, any = false;
  const B = BigInt(base);
  let bad = false;
  for (const ch of s) {
    const d = parseInt(ch, 36);
    if (isNaN(d) || d >= base) { bad = true; continue; }
    r = r * B + BigInt(d); any = true;
  }
  if (bad) deprecated('Invalid characters passed for attempted conversion, these have been ignored');
  void any;
  if (r > I64MAX) return mkf(Number(r));
  return normBig(r);
}
def('hexdec', (hex_string) => baseToDec(S(hex_string), 16));
def('bindec', (binary_string) => baseToDec(S(binary_string), 2));
def('octdec', (octal_string) => baseToDec(S(octal_string), 8));
def('base_convert', (num, from_base, to_base) => {
  const fb = I(from_base), tb = I(to_base);
  if (fb < 2 || fb > 36) throwError('ValueError', 'base_convert(): Argument #2 ($from_base) must be between 2 and 36 (inclusive)');
  if (tb < 2 || tb > 36) throwError('ValueError', 'base_convert(): Argument #3 ($to_base) must be between 2 and 36 (inclusive)');
  const v = baseToDec(S(num).toLowerCase(), fb);
  const b = v instanceof Flt ? BigInt(Math.floor(v.v)) : BigInt(v);
  return b.toString(I(to_base));
});
def('wordwrap', (string, width = 75, _break = '\n', cut_long_words = false) => {
  const s = S(string), w = I(width), br = S(_break), cut = toBool(cut_long_words);
  if (s === '') return '';
  if (w === 0 && cut) throwError('ValueError', "wordwrap(): Argument #4 ($cut_long_words) cannot be true when argument #2 ($width) is 0");
  // port of PHP's algorithm
  const blen = br.length;
  let out = '', laststart = 0, lastspace = 0, current = 0;
  for (current = 0; current < s.length; current++) {
    if (s[current] === br[0] && current + blen < s.length && s.substr(current, blen) === br) {
      out += s.slice(laststart, current + blen); current += blen - 1; laststart = lastspace = current + 1;
    } else if (s[current] === ' ') {
      if (current - laststart >= w) { out += s.slice(laststart, current) + br; laststart = current + 1; }
      lastspace = current;
    } else if (current - laststart >= w && cut && laststart >= lastspace) {
      out += s.slice(laststart, current) + br; laststart = lastspace = current;
    } else if (current - laststart >= w && laststart < lastspace) {
      out += s.slice(laststart, lastspace) + br; laststart = lastspace = lastspace + 1;
    }
  }
  if (laststart !== current) out += s.slice(laststart, current);
  return out;
});
def('chunk_split', (string, length = 76, separator = '\r\n') => {
  const s = S(string), n = I(length), e = S(separator);
  if (n < 1) throwError('ValueError', 'chunk_split(): Argument #2 ($length) must be greater than 0');
  if (n > s.length) return s + e;
  let out = ''; for (let i = 0; i < s.length; i += n) out += s.slice(i, i + n) + e;
  return out;
});
def('str_word_count', (string, format = 0, characters = null) => {
  const s = S(string);
  const extra = characters === null ? '' : S(characters).replace(/[\]\\^-]/g, '\\$&');
  const re = new RegExp(`[A-Za-z'${extra}-]+`, 'g');
  const words = []; let m;
  while ((m = re.exec(s))) { let w = m[0], off = m.index; if (w.startsWith('-') && !extra.includes('-')) { w = w.slice(1); off++; } if (w.endsWith('-') && !extra.includes('-')) w = w.slice(0, -1); if (w) words.push([off, w]); }
  const f = I(format);
  if (f === 1) return PHPArray.from(words.map((x) => x[1]));
  if (f === 2) return PHPArray.fromPairs(words.map((x) => [x[0], x[1]]));
  return words.length;
});
def('similar_text', (string1, string2, percent = undefined) => {
  const a = S(string1), b = S(string2);
  const sim = (s1, s2) => {
    if (!s1.length || !s2.length) return 0;
    let max = 0, p1 = 0, p2 = 0;
    for (let i = 0; i < s1.length; i++) for (let j = 0; j < s2.length; j++) {
      let k = 0; while (i + k < s1.length && j + k < s2.length && s1[i + k] === s2[j + k]) k++;
      if (k > max) { max = k; p1 = i; p2 = j; }
    }
    if (!max) return 0;
    return max + sim(s1.slice(0, p1), s2.slice(0, p2)) + sim(s1.slice(p1 + max), s2.slice(p2 + max));
  };
  const r = sim(a, b);
  if (percent instanceof Ref) percent.v = mkf(a.length + b.length ? (r * 2 * 100) / (a.length + b.length) : 0);
  return r;
}, { refs: [false, false, true] });
def('levenshtein', (string1, string2, insertion_cost = 1, replacement_cost = 1, deletion_cost = 1) => {
  const a = S(string1), b = S(string2), ci = I(insertion_cost), cr = I(replacement_cost), cd = I(deletion_cost);
  if (!a.length) return b.length * ci;
  if (!b.length) return a.length * cd;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j * ci);
  for (let i = 0; i < a.length; i++) {
    const cur = [(i + 1) * cd];
    for (let j = 0; j < b.length; j++) cur.push(Math.min(prev[j] + (a[i] === b[j] ? 0 : cr), prev[j + 1] + cd, cur[j] + ci));
    prev = cur;
  }
  return prev[b.length];
});
def('soundex', (string) => {
  if (S(string) === '') return '';
  const s = upper(S(string)).replace(/[^A-Z]/g, '');
  if (!s) return '0000';
  const codes = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let out = s[0], last = codes[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = s[i], code = codes[c] || 0;
    if (code && code !== last) out += code;
    if (c !== 'H' && c !== 'W') last = code;
  }
  return out.padEnd(4, '0');
});
def('metaphone', (string) => upper(S(string)).replace(/[^A-Z]/g, ''));
def('str_word_count_dummy', () => 0);
def('ucwords_dummy', () => 0);
def('nl_langinfo', () => false);
def('lcg_value', () => mkf(Math.random()));
def('sprintf_dummy', () => 0);
def('money_format', (format, num) => numberFormat(N(num), 2, '.', ','));
def('str_word', () => 0);
def('strval', (value) => toStr(value));
def('count_chars', (string, mode = 0) => {
  const s = S(string), m = I(mode);
  const counts = new Array(256).fill(0);
  for (let i = 0; i < s.length; i++) counts[s.charCodeAt(i)]++;
  if (m === 0) return PHPArray.from(counts);
  if (m === 1) return PHPArray.fromPairs(counts.map((c, i) => [i, c]).filter((x) => x[1] > 0));
  if (m === 2) return PHPArray.fromPairs(counts.map((c, i) => [i, c]).filter((x) => x[1] === 0));
  if (m === 3) return counts.map((c, i) => (c ? String.fromCharCode(i) : '')).join('');
  return counts.map((c, i) => (!c ? String.fromCharCode(i) : '')).join('');
});
def('str_word_count2', () => 0);
for (const k of ['str_word_count_dummy', 'ucwords_dummy', 'sprintf_dummy', 'str_word', 'str_word_count2']) rt.fns.delete(k);

// ---------------------------------------------------------------- hashing & encoding
const md5 = (s) => crypto.createHash('md5').update(bytes(s)).digest();
def('md5', (string, binary = false) => { const d = md5(S(string)); return toBool(binary) ? fromBytes(d) : d.toString('hex'); });
def('sha1', (string, binary = false) => { const d = crypto.createHash('sha1').update(bytes(S(string))).digest(); return toBool(binary) ? fromBytes(d) : d.toString('hex'); });
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(s) { let c = -1; for (let i = 0; i < s.length; i++) c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
def('crc32', (string) => crc32(S(string)));
const HASH_ALIASES = { sha224: 'sha224', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512', md5: 'md5', sha1: 'sha1', 'sha3-256': 'sha3-256', 'sha3-512': 'sha3-512', 'sha3-224': 'sha3-224', 'sha3-384': 'sha3-384', 'sha512/256': 'sha512-256', 'sha512/224': 'sha512-224', ripemd160: 'ripemd160', whirlpool: 'whirlpool', md4: 'md4' };
function hashImpl(algo, data, bin) {
  const a = algo.toLowerCase();
  if (a === 'crc32b') { const v = crc32(data); const h = v.toString(16).padStart(8, '0'); return bin ? fromBytes(Buffer.from(h, 'hex')) : h; }
  if (a === 'adler32') { let x = 1, y = 0; for (let i = 0; i < data.length; i++) { x = (x + data.charCodeAt(i)) % 65521; y = (y + x) % 65521; } const h = ((y << 16) | x) >>> 0; const hs = h.toString(16).padStart(8, '0'); return bin ? fromBytes(Buffer.from(hs, 'hex')) : hs; }
  if (a === 'fnv1a32' || a === 'fnv132') { let h = 0x811c9dc5; for (let i = 0; i < data.length; i++) { if (a === 'fnv1a32') { h ^= data.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } else { h = Math.imul(h, 0x01000193) >>> 0; h ^= data.charCodeAt(i); } } const hs = (h >>> 0).toString(16).padStart(8, '0'); return bin ? fromBytes(Buffer.from(hs, 'hex')) : hs; }
  const na = HASH_ALIASES[a];
  if (!na) throwError('ValueError', `hash(): Argument #1 ($algo) must be a valid hashing algorithm`);
  const d = crypto.createHash(na).update(bytes(data)).digest();
  return bin ? fromBytes(d) : d.toString('hex');
}
def('hash', (algo, data, binary = false) => hashImpl(S(algo), S(data), toBool(binary)));
def('hash_algos', () => PHPArray.from(['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512/224', 'sha512/256', 'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512', 'ripemd160', 'crc32b', 'adler32', 'fnv132', 'fnv1a32']));
def('hash_hmac', (algo, data, key, binary = false) => {
  const na = HASH_ALIASES[S(algo).toLowerCase()];
  if (!na) throwError('ValueError', 'hash_hmac(): Argument #1 ($algo) must be a valid cryptographic hashing algorithm');
  const d = crypto.createHmac(na, bytes(S(key))).update(bytes(S(data))).digest();
  return toBool(binary) ? fromBytes(d) : d.toString('hex');
});
def('hash_equals', (known_string, user_string) => S(known_string) === S(user_string));
def('md5_file', (filename, binary = false) => { try { const d = crypto.createHash('md5').update(fs.readFileSync(S(filename))).digest(); return toBool(binary) ? fromBytes(d) : d.toString('hex'); } catch (e) { warn(`md5_file(${filename}): Failed to open stream: No such file or directory`); return false; } });
def('sha1_file', (filename, binary = false) => { try { const d = crypto.createHash('sha1').update(fs.readFileSync(S(filename))).digest(); return toBool(binary) ? fromBytes(d) : d.toString('hex'); } catch (e) { return false; } });
def('hash_file', (algo, filename, binary = false) => { try { return hashImpl(S(algo), fromBytes(fs.readFileSync(S(filename))), toBool(binary)); } catch (e) { return false; } });
def('base64_encode', (string) => bytes(S(string)).toString('base64'));
def('base64_decode', (string, strict = false) => {
  const s = S(string);
  if (toBool(strict) && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(s)) return false;
  return fromBytes(Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
});
def('urlencode', (string) => {
  return S(string).replace(/[^A-Za-z0-9_.-]/g, (c) => (c === ' ' ? '+' : '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')));
});
def('rawurlencode', (string) => S(string).replace(/[^A-Za-z0-9_.~-]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')));
def('urldecode', (string) => S(string).replace(/\+/g, ' ').replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
def('rawurldecode', (string) => S(string).replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
def('http_build_query', (data, numeric_prefix = '', arg_separator = '&', encoding_type = 1) => {
  const parts = [];
  const enc = (s) => (I(encoding_type) === 2 ? callNative(rt.fns.get('rawurlencode'), [s]) : callNative(rt.fns.get('urlencode'), [s]));
  const walk = (v, prefix) => {
    const entries = v instanceof PHPArray ? v.entries() : objVisibleProps(v, null);
    for (const [k, x] of entries) {
      const key = prefix ? `${prefix}[${k}]` : (typeof k === 'number' ? S(numeric_prefix) + k : String(k));
      if (x instanceof PHPArray || x instanceof PHPObject) walk(x, key);
      else if (x === null) continue;
      else parts.push(enc(key) + '=' + enc(x === true ? '1' : x === false ? '0' : toStr(x)));
    }
  };
  walk(data, '');
  return parts.join(S(arg_separator));
});
def('parse_str', (string, result) => {
  const out = new PHPArray();
  for (const pair of S(string).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const dec = (x) => x.replace(/\+/g, ' ').replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    let k = dec(eq < 0 ? pair : pair.slice(0, eq));
    const v = eq < 0 ? '' : dec(pair.slice(eq + 1));
    const m = /^([^[]+)((?:\[[^\]]*\])*)$/.exec(k);
    if (!m) { out.set(normKey(k), v); continue; }
    const base = m[1].replace(/[ .]/g, '_');
    const subs = m[2] ? m[2].slice(1, -1).split('][') : [];
    if (!subs.length) { out.set(normKey(base), v); continue; }
    let cur = out, key = normKey(base);
    for (const sk of subs) {
      let next = cur.get(key);
      if (!(next instanceof PHPArray)) { next = new PHPArray(); cur.set(key, next); }
      cur = next; key = sk === '' ? null : normKey(sk);
      if (key === null) { key = cur.nextKey(); }
    }
    cur.set(key, v);
  }
  if (result instanceof Ref) result.v = out;
}, { refs: [false, true], min: 2 });
def('parse_url', (url, component = -1) => {
  const u = S(url);
  const m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(u);
  if (!m) return false;
  const r = new PHPArray();
  if (m[1]) r.set('scheme', m[1]);
  if (m[4] !== undefined && m[4] !== '') r.set('host', m[4]);
  if (m[5]) r.set('port', parseInt(m[5], 10));
  if (m[2] !== undefined) r.set('user', m[2]);
  if (m[3] !== undefined) r.set('pass', m[3]);
  if (m[6]) r.set('path', m[6]);
  if (m[7] !== undefined) r.set('query', m[7]);
  if (m[8] !== undefined) r.set('fragment', m[8]);
  const c = I(component);
  if (c === -1) return r;
  const names = ['scheme', 'host', 'port', 'user', 'pass', 'path', 'query', 'fragment'];
  const v = r.get(names[c]);
  return v === undefined ? null : v;
});
def('uniqid', (prefix = '', more_entropy = false) => {
  const t = Date.now() * 1000 + Math.floor((performance.now() * 1000) % 1000);
  const sec = Math.floor(t / 1e6), usec = t % 1e6;
  let s = S(prefix) + sec.toString(16).padStart(8, '0') + usec.toString(16).padStart(5, '0');
  if (toBool(more_entropy)) s += '.' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  return s;
});
def('str_rot13', (string) => S(string).replace(/[a-zA-Z]/g, (c) => { const b = c <= 'Z' ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b); }));
def('str_shuffle', (string) => { const a = S(string).split(''); for (let i = a.length - 1; i > 0; i--) { const j = mtRange(0, i); if (j !== i) [a[i], a[j]] = [a[j], a[i]]; } return a.join(''); });
def('nl2br_dummy', () => 0); rt.fns.delete('nl2br_dummy');
def('utf8_encode', (string) => utf8Encode(S(string)));
def('utf8_decode', (string) => { const u = utf8Decode(S(string)); let out = ''; for (const ch of u) { const c = ch.codePointAt(0); out += c < 256 ? ch : '?'; } return out; });
def('convert_uuencode', (string) => {
  const src = S(string); const e = src.length; const b = (i) => (i < e ? src.charCodeAt(i) : 0);
  const ENC = (c) => String.fromCharCode(c ? (c & 0o77) + 32 : 96);
  let out = '', s = 0, len = 45;
  const quad = (i) => ENC(b(i) >> 2) + ENC(((b(i) << 4) & 0o60) | ((b(i + 1) >> 4) & 0o17)) + ENC(((b(i + 1) << 2) & 0o74) | ((b(i + 2) >> 6) & 0o3)) + ENC(b(i + 2) & 0o77);
  while (s + 3 < e) {
    let ee = s + len;
    if (ee > e) { ee = e; len = ee - s; if (len % 3) ee = s + Math.floor(len / 3) * 3; }
    out += ENC(len);
    while (s < ee) { out += quad(s); s += 3; }
    if (len === 45) out += '\n';
  }
  if (s < e) {
    if (len === 45) { out += ENC(e - s); len = 0; }
    out += ENC(b(s) >> 2) + ENC(((b(s) << 4) & 0o60) | ((b(s + 1) >> 4) & 0o17));
    out += e - s > 1 ? ENC(((b(s + 1) << 2) & 0o74) | ((b(s + 2) >> 6) & 0o3)) : ENC(0);
    out += e - s > 2 ? ENC(b(s + 2) & 0o77) : ENC(0);
  }
  if (len < 45) out += '\n';
  return out + ENC(0) + '\n';
});
def('convert_uudecode', (string) => {
  const src = S(string); let out = '';
  const DEC = (c) => ((c.charCodeAt(0) - 32) & 0o77);
  for (const line of src.split('\n')) {
    if (!line) continue;
    const n = DEC(line[0]); if (n === 0) break;
    let bytesOut = '';
    for (let i = 1; i + 3 < line.length + 3 && bytesOut.length < n; i += 4) {
      const c = [0, 1, 2, 3].map((k) => DEC(line[i + k] || '`'));
      bytesOut += String.fromCharCode(((c[0] << 2) | (c[1] >> 4)) & 255, ((c[1] << 4) | (c[2] >> 2)) & 255, ((c[2] << 6) | c[3]) & 255);
    }
    out += bytesOut.slice(0, n);
  }
  return out;
});
def('quoted_printable_encode', (string) => {
  const s = S(string); const hex = '0123456789ABCDEF'; let out = '', lp = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 13 && s.charCodeAt(i + 1) === 10 && i + 1 < s.length) { out += '\r\n'; i++; lp = 0; continue; }
    if (c < 32 || c === 0x7f || c & 0x80 || c === 61 || (c === 32 && s.charCodeAt(i + 1) === 13)) {
      if (((lp += 3) > 75 && c <= 0x7f) || (c > 0x7f && c <= 0xdf && lp + 3 > 75) || (c > 0xdf && c <= 0xef && lp + 6 > 75) || (c > 0xef && c <= 0xf4 && lp + 9 > 75)) { out += '=\r\n'; lp = 3; }
      out += '=' + hex[c >> 4] + hex[c & 15];
    } else {
      if (++lp > 75) { out += '=\r\n'; lp = 1; }
      out += s[i];
    }
  }
  return out;
});
def('quoted_printable_decode', (string) => S(string).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))));

// ---------------------------------------------------------------- multibyte
const mbChars = (s) => Array.from(utf8Decode(s));
def('mb_strlen', (string, encoding = null) => (encoding !== null && /^(8bit|ascii|latin1|iso-8859-1)$/i.test(S(encoding)) ? S(string).length : mbChars(S(string)).length));
def('mb_substr', (string, start, length = null, encoding = null) => {
  const ch = mbChars(S(string)); let st = I(start); const n = ch.length;
  if (st < 0) st = Math.max(0, n + st); if (st > n) return '';
  let end = length === null ? n : I(length) < 0 ? n + I(length) : st + I(length);
  if (end < st) return '';
  return utf8Encode(ch.slice(st, end).join(''));
});
def('mb_strtoupper', (string, encoding = null) => utf8Encode(utf8Decode(S(string)).toUpperCase()));
def('mb_strtolower', (string, encoding = null) => utf8Encode(utf8Decode(S(string)).toLowerCase()));
def('mb_convert_case', (string, mode, encoding = null) => {
  const u = utf8Decode(S(string)); const m = I(mode);
  if (m === 0 || m === 4) return utf8Encode(u.toUpperCase());
  if (m === 1 || m === 5) return utf8Encode(u.toLowerCase());
  return utf8Encode(u.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (x, a, b) => a + b.toUpperCase()));
});
def('mb_str_split', (string, length = 1, encoding = null) => { const ch = mbChars(S(string)); const n = I(length); const out = []; for (let i = 0; i < ch.length; i += n) out.push(utf8Encode(ch.slice(i, i + n).join(''))); return PHPArray.from(out); });
function mbIndex(chars, sub, off, last, ci) {
  let h = chars, nd = mbChars(sub);
  if (ci) { h = h.map((c) => c.toLowerCase()); nd = nd.map((c) => c.toLowerCase()); }
  const hs = h.join(''), ns = nd.join('');
  // convert char offset -> utf16 index
  const toU = (ci2) => h.slice(0, ci2).join('').length;
  let idx;
  if (!last) { if (off < 0) off += h.length; idx = hs.indexOf(ns, toU(Math.max(0, off))); }
  else { idx = hs.lastIndexOf(ns); if (off < 0) { const lim = toU(h.length + off); idx = hs.lastIndexOf(ns, lim); } else if (idx >= 0 && Array.from(hs.slice(0, idx)).length < off) idx = -1; }
  if (idx < 0) return false;
  return Array.from(hs.slice(0, idx)).length;
}
def('mb_strpos', (haystack, needle, offset = 0, encoding = null) => mbIndex(mbChars(S(haystack)), S(needle), I(offset), false, false));
def('mb_stripos', (haystack, needle, offset = 0, encoding = null) => mbIndex(mbChars(S(haystack)), S(needle), I(offset), false, true));
def('mb_strrpos', (haystack, needle, offset = 0, encoding = null) => mbIndex(mbChars(S(haystack)), S(needle), I(offset), true, false));
def('mb_strripos', (haystack, needle, offset = 0, encoding = null) => mbIndex(mbChars(S(haystack)), S(needle), I(offset), true, true));
def('mb_substr_count', (haystack, needle, encoding = null) => { const h = utf8Decode(S(haystack)), n = utf8Decode(S(needle)); if (!n) throwError('ValueError', 'mb_substr_count(): Argument #2 ($needle) must not be empty'); return h.split(n).length - 1; });
def('mb_str_pad', (string, length, pad_string = ' ', pad_type = 1, encoding = null) => {
  const s = mbChars(S(string)), p = mbChars(S(pad_string)), len = I(length), t = I(pad_type);
  if (len <= s.length || !p.length) return S(string);
  const total = len - s.length;
  const mk = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(p[i % p.length]); return out.join(''); };
  if (t === 0) return utf8Encode(mk(total) + s.join(''));
  if (t === 2) { const l = Math.floor(total / 2); return utf8Encode(mk(l) + s.join('') + mk(total - l)); }
  return utf8Encode(s.join('') + mk(total));
});
def('mb_internal_encoding', (encoding = null) => (encoding === null ? 'UTF-8' : true));
def('mb_check_encoding', (value = null, encoding = null) => (value === null ? true : isValidUtf8(S(value))));
def('mb_detect_encoding', (string) => (isValidUtf8(S(string)) ? (/[\x80-\xff]/.test(S(string)) ? 'UTF-8' : 'ASCII') : false));
def('mb_convert_encoding', (string, to_encoding, from_encoding = null) => {
  const s = S(string), to = S(to_encoding).toUpperCase(), from = from_encoding === null ? 'UTF-8' : toStr(from_encoding).toUpperCase();
  let u;
  if (/^(ISO-8859-1|LATIN1|WINDOWS-1252|CP1252)$/.test(from)) u = s; else u = utf8Decode(s);
  if (/^(ISO-8859-1|LATIN1|WINDOWS-1252|CP1252|ASCII)$/.test(to)) { let out = ''; for (const ch of u) { const c = ch.codePointAt(0); out += c < 256 ? ch : '?'; } return out; }
  if (to === 'HTML-ENTITIES') { let out = ''; for (const ch of u) { const c = ch.codePointAt(0); out += c < 128 ? ch : '&#' + c + ';'; } return out; }
  return utf8Encode(u);
});
def('mb_strwidth', (string, encoding = null) => { let w = 0; for (const ch of utf8Decode(S(string))) { const c = ch.codePointAt(0); w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1; } return w; });
def('mb_strimwidth', (string, start, width, trim_marker = '', encoding = null) => {
  const ch = mbChars(S(string)).slice(I(start)); const w = I(width); const tm = mbChars(S(trim_marker));
  if (ch.length <= w) return utf8Encode(ch.join(''));
  return utf8Encode(ch.slice(0, Math.max(0, w - tm.length)).join('') + tm.join(''));
});
def('mb_ord', (string, encoding = null) => { const s = utf8Decode(S(string)); return s.length ? s.codePointAt(0) : false; });
def('mb_chr', (codepoint, encoding = null) => utf8Encode(String.fromCodePoint(I(codepoint))));
def('mb_strrev', (string) => utf8Encode(mbChars(S(string)).reverse().join('')));
rt.fns.delete('mb_strrev');
def('mb_ucfirst', (string, encoding = null) => { const c = mbChars(S(string)); if (c.length) c[0] = c[0].toUpperCase(); return utf8Encode(c.join('')); });
def('mb_lcfirst', (string, encoding = null) => { const c = mbChars(S(string)); if (c.length) c[0] = c[0].toLowerCase(); return utf8Encode(c.join('')); });
def('mb_trim', (string, characters = null, encoding = null) => utf8Encode(utf8Decode(S(string)).trim()));
def('mb_substitute_character', () => true);
def('mb_language', () => 'neutral');
def('mb_list_encodings', () => PHPArray.from(['UTF-8', 'ASCII', 'ISO-8859-1']));
def('mb_strstr', (haystack, needle, before_needle = false, encoding = null) => { const h = S(haystack); const p = h.indexOf(S(needle)); if (p < 0) return false; return toBool(before_needle) ? h.slice(0, p) : h.slice(p); });
def('iconv', (from_encoding, to_encoding, string) => callNative(rt.fns.get('mb_convert_encoding'), [string, S(to_encoding).replace(/\/\/.*$/, ''), S(from_encoding)]));
def('iconv_strlen', (string, encoding = null) => mbChars(S(string)).length);
def('iconv_substr', (string, offset, length = null) => callNative(rt.fns.get('mb_substr'), [string, offset, length]));
def('iconv_strpos', (haystack, needle, offset = 0) => mbIndex(mbChars(S(haystack)), S(needle), I(offset), false, false));

// ctype
const ctype = (re) => (text) => { if (isInt(text)) { const n = Number(text); if (n >= -128 && n <= 255) text = String.fromCharCode(n < 0 ? n + 256 : n); else text = String(n); } if (typeof text !== 'string' || text === '') return false; return re.test(text); };
def('ctype_digit', ctype(/^[0-9]+$/));
def('ctype_alpha', ctype(/^[A-Za-z]+$/));
def('ctype_alnum', ctype(/^[A-Za-z0-9]+$/));
def('ctype_upper', ctype(/^[A-Z]+$/));
def('ctype_lower', ctype(/^[a-z]+$/));
def('ctype_space', ctype(/^[ \t\n\r\v\f]+$/));
def('ctype_punct', ctype(/^[!-/:-@[-`{-~]+$/));
def('ctype_xdigit', ctype(/^[0-9A-Fa-f]+$/));
def('ctype_cntrl', ctype(/^[\x00-\x1f\x7f]+$/));
def('ctype_print', ctype(/^[\x20-\x7e]+$/));
def('ctype_graph', ctype(/^[\x21-\x7e]+$/));

// ---------------------------------------------------------------- math
def('abs', (num) => { const v = IntN(num); if (v instanceof Flt) return mkf(Math.abs(v.v)); if (typeof v === 'bigint') return bigOrFloat(v < 0n ? -v : v, Math.abs(Number(v))); return Math.abs(v); });
def('ceil', (num) => mkf(Math.ceil(N(num))));
def('floor', (num) => mkf(Math.floor(N(num))));
def('round', (num, precision = 0, mode = 1) => { const v = IntN(num); const p = I(precision); if (isInt(v) && p >= 0) return mkf(Number(v)); return mkf(phpRound(toDbl(v), p, I(mode))); });
def('sqrt', (num) => mkf(Math.sqrt(N(num))));
def('pow', (num, exponent) => pow(num, exponent));
def('intdiv', (num1, num2) => {
  const a = I(num1), b = I(num2);
  if (b === 0 || b === 0n) throwError('DivisionByZeroError', 'Division by zero');
  if (typeof a === 'number' && typeof b === 'number') { const r = Math.trunc(a / b); return r === 0 ? 0 : r; }
  if (BigInt(a) === I64MIN && BigInt(b) === -1n) throwError('ArithmeticError', 'Division of PHP_INT_MIN by -1 is not an integer');
  return normBig(BigInt(a) / BigInt(b));
});
def('fmod', (num1, num2) => mkf(N(num1) % N(num2)));
def('fdiv', (num1, num2) => mkf(N(num1) / N(num2)));
def('exp', (num) => mkf(Math.exp(N(num))));
def('expm1', (num) => mkf(Math.expm1(N(num))));
def('log', (num, base = Math.E) => { const x = N(num), b = N(base); if (b === Math.E) return mkf(Math.log(x)); if (b <= 0) throwError('ValueError', 'log(): Argument #2 ($base) must be greater than 0'); return mkf(Math.log(x) / Math.log(b)); });
def('log10', (num) => mkf(Math.log10(N(num))));
def('log2', (num) => mkf(Math.log2(N(num))));
def('log1p', (num) => mkf(Math.log1p(N(num))));
for (const f of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh']) def(f, (num) => mkf(Math[f](N(num))));
def('atan2', (y, x) => mkf(Math.atan2(N(y), N(x))));
def('pi', () => mkf(Math.PI));
def('hypot', (x, y) => mkf(Math.hypot(N(x), N(y))));
def('deg2rad', (num) => mkf((N(num) * Math.PI) / 180));
def('rad2deg', (num) => mkf((N(num) * 180) / Math.PI));
def('is_nan', (num) => { const x = N(num); return x !== x; });
def('is_finite', (num) => isFinite(N(num)));
def('is_infinite', (num) => { const x = N(num); return x === Infinity || x === -Infinity; });
function minmax(args, dir, name) {
  let list = args;
  if (args.length === 1) {
    const a = args[0];
    if (!(a instanceof PHPArray)) throwError('TypeError', `${name}(): Argument #1 ($value) must be of type array, ${typeOf(a)} given`);
    list = a.values();
    if (!list.length) throwError('ValueError', `${name}(): Argument #1 ($value) must contain at least one element`);
  }
  let best = list[0];
  for (let i = 1; i < list.length; i++) { const c = cmp(list[i], best); if (dir > 0 ? c > 0 : c < 0) best = list[i]; }
  return best;
}
def('max', (value, ...values) => minmax([value, ...values], 1, 'max'));
def('min', (value, ...values) => minmax([value, ...values], -1, 'min'));
// Mersenne Twister (compatible with PHP mt_rand when seeded)
class MT19937 {
  constructor(seed) { this.mt = new Uint32Array(624); this.seed(seed); }
  seed(s) { const mt = this.mt; mt[0] = s >>> 0; for (let i = 1; i < 624; i++) { const p = mt[i - 1] ^ (mt[i - 1] >>> 30); mt[i] = (Math.imul(1812433253, p) + i) >>> 0; } this.idx = 624; }
  reload() {
    const mt = this.mt;
    const twist = (m, u, v) => (m ^ (((u & 0x80000000) | (v & 0x7fffffff)) >>> 1) ^ ((-(v & 1)) & 0x9908b0df)) >>> 0;
    let i = 0;
    for (; i < 624 - 397; i++) mt[i] = twist(mt[i + 397], mt[i], mt[i + 1]);
    for (; i < 623; i++) mt[i] = twist(mt[i + 397 - 624], mt[i], mt[i + 1]);
    mt[623] = twist(mt[396], mt[623], mt[0]);
    this.idx = 0;
  }
  next() {
    if (this.idx >= 624) this.reload();
    let y = this.mt[this.idx++];
    y ^= y >>> 11; y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0; y = (y ^ ((y << 15) & 0xefc60000)) >>> 0; y ^= y >>> 18;
    return y >>> 0;
  }
}
let mt = null;
function mtRange(min, max) {
  if (!mt) mt = new MT19937((Math.random() * 0x100000000) >>> 0);
  const umax = max - min;
  if (umax <= 0) return min;
  if (umax > 0xFFFFFFFE) { const r = Math.floor(Math.random() * (umax + 1)); return min + r; }
  const limit = 0xFFFFFFFF - (0xFFFFFFFF % (umax + 1)) - 1;
  let r = mt.next();
  if ((umax + 1) & umax) { while (r > limit) r = mt.next(); }
  return min + (r % (umax + 1));
}
def('mt_srand', (seed = null, mode = 0) => { mt = new MT19937(seed === null ? (Math.random() * 0x100000000) >>> 0 : Number(BigInt.asUintN(32, BigInt(I(seed))))); });
alias('srand', 'mt_srand');
def('mt_rand', (min = undefined, max = undefined) => {
  if (min === undefined) { if (!mt) mt = new MT19937((Math.random() * 0x100000000) >>> 0); return mt.next() >>> 1; }
  const a = Number(I(min)), b = Number(I(max));
  if (b < a) throwError('ValueError', 'mt_rand(): Argument #2 ($max) must be greater than or equal to argument #1 ($min)');
  return mtRange(a, b);
}, { min: 0 });
def('rand', (min = undefined, max = undefined) => {
  if (min === undefined) return callNative(rt.fns.get('mt_rand'), []);
  const a = Number(I(min)), b = Number(I(max));
  if (b < a) return mtRange(b, a);
  return mtRange(a, b);
}, { min: 0 });
def('mt_getrandmax', () => 2147483647);
alias('getrandmax', 'mt_getrandmax');
def('random_int', (min, max) => {
  const a = I(min), b = I(max);
  if (b < a) throwError('ValueError', 'random_int(): Argument #1 ($min) must be less than or equal to argument #2 ($max)');
  const range = BigInt(b) - BigInt(a) + 1n;
  if (range <= 0xFFFFFFFFn) return Number(BigInt(a) + BigInt(crypto.randomInt(0, Number(range))));
  const buf = crypto.randomBytes(8); const r = buf.readBigUInt64BE() % range;
  return normBig(BigInt(a) + r);
});
def('random_bytes', (length) => fromBytes(crypto.randomBytes(I(length))));

// ---------------------------------------------------------------- arrays
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
const R1 = { refs: [true] };
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
  const a = A(deref(array));
  const out = new PHPArray();
  for (const v of values) out.push(cp(v));
  for (const [k, v] of a.rawEntries()) { if (typeof k === 'string') out.setRaw(k, v); else out.push(v); }
  array.v = out;
  return out.size;
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

// ---------------------------------------------------------------- types
def('gettype', (value) => gettype(value));
def('get_debug_type', (value) => typeOf(value));
def('is_int', (value) => isInt(value));
alias('is_integer', 'is_int'); alias('is_long', 'is_int');
def('is_float', (value) => value instanceof Flt);
alias('is_double', 'is_float');
def('is_string', (value) => typeof value === 'string');
def('is_bool', (value) => typeof value === 'boolean');
def('is_array', (value) => value instanceof PHPArray);
def('is_object', (value) => value instanceof PHPObject);
def('is_null', (value) => value === null || value === undefined);
def('is_resource', (value) => value instanceof PHPResource && !value.closed);
def('is_numeric', (value) => isNum(value) || (typeof value === 'string' && NUM_FULL.test(value)));
def('is_scalar', (value) => isNum(value) || typeof value === 'string' || typeof value === 'boolean');
def('is_iterable', (value) => value instanceof PHPArray || (value instanceof PHPObject && value.cls.ancestors.has('traversable')));
def('is_countable', (value) => value instanceof PHPArray || (value instanceof PHPObject && value.cls.ancestors.has('countable')));
def('is_callable', (value, syntax_only = false, callable_name = undefined) => {
  if (callable_name instanceof Ref) callable_name.v = callableName(value);
  if (toBool(syntax_only)) return typeof value === 'string' || value instanceof PHPArray || value instanceof PHPObject;
  return isCallable(value, rt.frame);
}, { refs: [false, false, true] });
def('intval', (value, base = 10) => {
  const b = I(base);
  if (typeof value !== 'string' || b === 10) return toInt(value);
  let s = value.trim().toLowerCase(); let neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  let bb = b;
  if (b === 0) { if (s.startsWith('0x')) { bb = 16; s = s.slice(2); } else if (s.startsWith('0b')) { bb = 2; s = s.slice(2); } else if (s.startsWith('0o')) { bb = 8; s = s.slice(2); } else if (s.startsWith('0') && s.length > 1) { bb = 8; s = s.slice(1); } else bb = 10; }
  else if (b === 16 && s.startsWith('0x')) s = s.slice(2);
  else if (b === 2 && s.startsWith('0b')) s = s.slice(2);
  else if (b === 8 && s.startsWith('0o')) s = s.slice(2);
  let r = 0n; const B2 = BigInt(bb);
  for (const ch of s) { const d = parseInt(ch, 36); if (isNaN(d) || d >= bb) break; r = r * B2 + BigInt(d); if (r > I64MAX + 1n) break; }
  if (neg) r = -r;
  if (r > I64MAX) return normBig(I64MAX); if (r < I64MIN) return normBig(I64MIN);
  return normBig(r);
});
def('floatval', (value) => mkf(toDbl(value)));
alias('doubleval', 'floatval');
def('boolval', (value) => toBool(value));
def('settype', (_var, type) => {
  const t = S(type).toLowerCase();
  const v = _var.v;
  switch (t) {
    case 'int': case 'integer': _var.v = toInt(v); break;
    case 'float': case 'double': _var.v = mkf(toDbl(v)); break;
    case 'string': _var.v = toStr(v); break;
    case 'bool': case 'boolean': _var.v = toBool(v); break;
    case 'array': _var.v = toArrayCast(v); break;
    case 'object': _var.v = toObjectCast(v); break;
    case 'null': _var.v = null; break;
    default: throwError('ValueError', 'settype(): Argument #2 ($type) must be a valid type');
  }
  return true;
}, R1);

// ---------------------------------------------------------------- functions / classes
def('function_exists', (function_name) => { let n = S(function_name); if (n[0] === '\\') n = n.slice(1); return rt.fns.has(n.toLowerCase()) || !!FRAME_FUNCS[n.toLowerCase()] || lazyFnSrc.has(n.toLowerCase()); });
def('call_user_func', (callback, ...args) => callValue(callback, args));
def('call_user_func_array', (callback, args) => {
  const a = A(args);
  const pos = []; let named = null;
  for (const [k, v] of a.entries()) { if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, v); } else pos.push(v); }
  const c = resolveCallable(callback, rt.frame, true);
  // by-ref params: wrap values in refs
  if (c.fn.refs) for (let i = 0; i < pos.length; i++) if (isRefParam(c.fn, i)) pos[i] = new Ref(pos[i]);
  if (named) pos.named = named;
  return invokeCallable(c, pos);
});
def('forward_static_call', (callback, ...args) => callValue(callback, args));
def('forward_static_call_array', (callback, args) => callValue(callback, A(args).values()));
def('get_class', (object = undefined) => {
  if (object === undefined) { const f = rt.frame; if (f && f.cls) return f.cls.name; throwError('Error', 'get_class() without arguments must be called from within a class'); }
  if (!(object instanceof PHPObject)) throwError('TypeError', `get_class(): Argument #1 ($object) must be of type object, ${typeOf(object)} given`);
  return object.cls.name;
}, { min: 0 });
def('get_parent_class', (object_or_class = undefined) => {
  let c;
  if (object_or_class === undefined) c = rt.frame ? rt.frame.cls : null;
  else if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else c = classExists(S(object_or_class), true);
  return c && c.parent ? c.parent.name : false;
}, { min: 0 });
def('get_object_vars', (object) => PHPArray.fromPairs(objVisibleProps(object, rt.frame ? rt.frame.cls : null).map(([k, v]) => [normKey(k), cp(v)])));
def('get_class_vars', (class_name) => {
  const c = lookupClass(S(class_name)); const out = new PHPArray(); const scope = rt.frame ? rt.frame.cls : null;
  for (const [, info] of c.slots) if (propAccessible(info, scope) && (info.vis !== 'private' || info.cls === scope)) out.set(info.name, info.hasDef ? cp(propDefault(info)) : null);
  for (const [n, si] of c.sprops) if (propAccessible(si, scope)) out.set(n, cp(lookupStaticProp(c, n).ref.v));
  return out;
});
def('get_class_methods', (object_or_class) => {
  const c = object_or_class instanceof PHPObject ? object_or_class.cls : lookupClass(S(object_or_class));
  const scope = rt.frame ? rt.frame.cls : null;
  return PHPArray.from([...c.methods.values()].filter((m) => canAccessMember(m, scope)).map((m) => m.name));
});
def('method_exists', (object_or_class, method) => {
  let c;
  if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else { c = classExists(S(object_or_class), true); if (!c) return false; }
  return c.methods.has(S(method).toLowerCase());
});
def('property_exists', (object_or_class, property) => {
  const p = S(property);
  if (object_or_class instanceof PHPObject) { if (object_or_class.props.has(p)) return true; return object_or_class.cls.props.has(p) || object_or_class.cls.sprops.has(p) || object_or_class.cls.privProps.has(p); }
  const c = classExists(S(object_or_class), true); if (!c) return false;
  return c.props.has(p) || c.sprops.has(p);
});
def('class_exists', (class_name, autoload = true) => { const c = classExists(S(class_name), toBool(autoload)); return !!c && !c.isInterface && !c.isTrait && !c.isEnum; });
def('interface_exists', (interface_name, autoload = true) => { const c = classExists(S(interface_name), toBool(autoload)); return !!c && c.isInterface; });
def('trait_exists', (trait, autoload = true) => { const c = classExists(S(trait), toBool(autoload)); return !!c && c.isTrait; });
def('enum_exists', (enum_name, autoload = true) => { const c = classExists(S(enum_name), toBool(autoload)); return !!c && c.isEnum; });
def('is_a', (object_or_class, class_name, allow_string = false) => {
  let c;
  if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else if (typeof object_or_class === 'string' && toBool(allow_string)) { c = classExists(object_or_class, true); if (!c) return false; }
  else return false;
  return c.ancestors.has(S(class_name).replace(/^\\/, '').toLowerCase());
});
def('is_subclass_of', (object_or_class, class_name, allow_string = true) => {
  let c;
  if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else if (typeof object_or_class === 'string' && toBool(allow_string)) { c = classExists(object_or_class, true); if (!c) return false; }
  else return false;
  const t = S(class_name).replace(/^\\/, '').toLowerCase();
  return c.lname !== t && c.ancestors.has(t);
});
def('class_implements', (object_or_class, autoload = true) => {
  const c = object_or_class instanceof PHPObject ? object_or_class.cls : classExists(S(object_or_class), toBool(autoload));
  if (!c) return false;
  const out = new PHPArray();
  for (const a of c.ancestors) { const ac = rt.classes.get(a); if (ac && ac.isInterface) out.set(ac.name, ac.name); }
  return out;
});
def('class_parents', (object_or_class, autoload = true) => {
  let c = object_or_class instanceof PHPObject ? object_or_class.cls : classExists(S(object_or_class), toBool(autoload));
  if (!c) return false;
  const out = new PHPArray(); for (c = c.parent; c; c = c.parent) out.set(c.name, c.name);
  return out;
});
def('class_uses', (object_or_class) => {
  const c = object_or_class instanceof PHPObject ? object_or_class.cls : classExists(S(object_or_class), true);
  if (!c) return false;
  const out = new PHPArray();
  for (const tu of c.decl ? c.decl.traits : []) for (const n of tu.names) { const t = lookupClass(n); out.set(t.name, t.name); }
  return out;
});
def('spl_object_id', (object) => object.id);
def('spl_object_hash', (object) => object.id.toString(16).padStart(32, '0'));
def('spl_autoload_register', (callback = null, _throw = true, prepend = false) => {
  if (callback === null) return true;
  if (toBool(prepend)) rt.autoloaders.unshift(callback); else rt.autoloaders.push(callback);
  return true;
});
def('spl_autoload_unregister', (callback) => { const i = rt.autoloaders.findIndex((c) => looseEq(c, callback) || c === callback); if (i >= 0) { rt.autoloaders.splice(i, 1); return true; } return false; });
def('spl_autoload_functions', () => PHPArray.from(rt.autoloaders.slice()));
def('get_declared_classes', () => PHPArray.from([...rt.classes.values()].filter((c) => !c.isInterface && !c.isTrait).map((c) => c.name)));
def('get_declared_interfaces', () => PHPArray.from([...rt.classes.values()].filter((c) => c.isInterface).map((c) => c.name)));
def('get_defined_functions', () => {
  const out = new PHPArray(); const internal = new PHPArray(), user = new PHPArray();
  for (const [k, f] of rt.fns) (f.native ? internal : user).push(k);
  out.set('internal', internal); out.set('user', user); return out;
});
def('define', (constant_name, value, case_insensitive = false) => {
  const n = S(constant_name);
  if (n.includes('::')) throwError('ValueError', 'define(): Argument #1 ($constant_name) cannot be a class constant');
  if (rt.consts.has(n)) { warn(`Constant ${n} already defined`); return false; }
  rt.consts.set(n, cp(value)); return true;
});
def('defined', (constant_name) => {
  const n = S(constant_name);
  if (n.includes('::')) { const [c, k] = n.split('::'); const cls = classExists(c, true); return !!cls && cls.consts.has(k); }
  return rt.consts.has(n.replace(/^\\/, ''));
});
def('constant', (name) => {
  const n = S(name);
  if (n.includes('::')) { const [c, k] = n.split('::'); return classConst(lookupClass(c), k, rt.frame); }
  const v = rt.consts.get(n.replace(/^\\/, ''));
  if (v === undefined) throwError('Error', `Undefined constant "${n}"`);
  return v;
});
def('get_defined_constants', (categorize = false) => { const out = new PHPArray(); for (const [k, v] of rt.consts) out.set(k, v); return out; });

// ---------------------------------------------------------------- errors & runtime config
def('error_reporting', (error_level = null) => { const old = rt.silence ? rt.errorReporting & 4437 : rt.errorReporting; if (error_level !== null) rt.errorReporting = I(error_level); return old; });
const INI_DEFAULTS = {
  'arg_separator.output': '&', 'arg_separator.input': '&', 'assert.active': '1', 'assert.exception': '1', 'assert.warning': '1', 'assert.bail': '0', 'assert.callback': '',
  'auto_detect_line_endings': '0', 'default_charset': 'UTF-8', 'default_socket_timeout': '60', 'display_startup_errors': '1', 'docref_root': '', 'docref_ext': '',
  'error_log': '', 'error_prepend_string': '', 'error_append_string': '', 'html_errors': '0', 'ignore_repeated_errors': '0', 'ignore_user_abort': '0', 'implicit_flush': '1',
  'include_path': '.:/usr/share/php', 'log_errors': '0', 'max_execution_time': '0', 'max_input_time': '-1', 'memory_limit': '128M', 'output_buffering': '0', 'output_handler': '',
  'register_argc_argv': '1', 'report_memleaks': '1', 'short_open_tag': '0', 'user_agent': '', 'variables_order': 'EGPCS', 'zend.assertions': '-1', 'zend.enable_gc': '1',
  'zend.exception_ignore_args': '1', 'zend.exception_string_param_max_len': '0', 'date.timezone': 'UTC', 'mbstring.language': 'neutral', 'mbstring.internal_encoding': '',
  'pcre.backtrack_limit': '1000000', 'pcre.recursion_limit': '100000', 'pcre.jit': '1', 'session.save_path': '', 'session.name': 'PHPSESSID', 'session.use_cookies': '1',
  'serialize_precision': '-1', 'precision': '14', 'display_errors': '0', 'error_reporting': '', 'open_basedir': '', 'file_uploads': '1', 'upload_max_filesize': '2M',
  'post_max_size': '8M', 'allow_url_fopen': '1', 'allow_url_include': '0', 'auto_prepend_file': '', 'auto_append_file': '', 'sys_temp_dir': '', 'xmlrpc_errors': '0',
  'highlight.comment': '#FF8000', 'highlight.default': '#0000BB', 'highlight.html': '#000000', 'highlight.keyword': '#007700', 'highlight.string': '#DD0000',
  'unserialize_callback_func': '', 'unserialize_max_depth': '4096', 'zend.multibyte': '0', 'zend.detect_unicode': '1', 'expose_php': '1', 'enable_dl': '1',
  'max_input_nesting_level': '64', 'max_input_vars': '1000', 'realpath_cache_size': '4096K', 'realpath_cache_ttl': '120', 'opcache.enable': '0', 'opcache.enable_cli': '0',
};
def('ini_set', (option, value) => {
  const k = S(option); const v = value === null ? '' : toStr(value);
  if (!(k in INI_DEFAULTS) && !rt.ini.has(k)) return false;
  const old = ini_get(k);
  if (k === 'display_errors') rt.displayErrors = (v === '1' || v.toLowerCase() === 'on' || v.toLowerCase() === 'true' || v.toLowerCase() === 'stdout') ? 'stdout' : (v.toLowerCase() === 'stderr' ? 'stderr' : '0');
  else if (k === 'error_reporting') rt.errorReporting = toInt(v);
  else if (k === 'precision') rt.precision = toInt(v);
  else if (k === 'serialize_precision') rt.serializePrecision = toInt(v);
  else if (k === 'date.timezone') rt.tz = v;
  rt.ini.set(k, v);
  return old;
});
alias('ini_alter', 'ini_set');
function ini_get(k) {
  if (rt.ini.has(k)) return rt.ini.get(k);
  switch (k) {
    case 'display_errors': return rt.displayErrors === 'stdout' ? '1' : rt.displayErrors === 'stderr' ? 'stderr' : '0';
    case 'error_reporting': return String(rt.errorReporting);
    case 'precision': return String(rt.precision);
    case 'serialize_precision': return String(rt.serializePrecision);
    case 'memory_limit': return '128M';
    case 'max_execution_time': return '0';
    case 'date.timezone': return rt.tz;
    case 'default_charset': return 'UTF-8';
    case 'include_path': return '.:/usr/share/php';
  }
  if (k in INI_DEFAULTS) return INI_DEFAULTS[k];
  return false;
}
def('ini_get', (option) => ini_get(S(option)));
def('ini_get_all', () => new PHPArray());
def('ini_restore', (option) => { rt.ini.delete(S(option)); });
def('set_include_path', (include_path) => { const old = ini_get('include_path'); rt.ini.set('include_path', S(include_path)); return old; });
def('get_include_path', () => ini_get('include_path'));
def('set_error_handler', (callback, error_levels = E_ALL) => {
  const prev = rt.errorHandlers.length ? rt.errorHandlers[rt.errorHandlers.length - 1].handler : null;
  rt.errorHandlers.push({ handler: callback, mask: I(error_levels) });
  return prev;
});
def('restore_error_handler', () => { rt.errorHandlers.pop(); return true; });
def('set_exception_handler', (callback) => { const prev = rt.exceptionHandlers.length ? rt.exceptionHandlers[rt.exceptionHandlers.length - 1] : null; rt.exceptionHandlers.push(callback); return prev; });
def('restore_exception_handler', () => { rt.exceptionHandlers.pop(); return true; });
def('trigger_error', (message, error_level = E_USER_NOTICE) => {
  const lvl = I(error_level);
  if (![E_USER_ERROR, E_USER_WARNING, E_USER_NOTICE, E_USER_DEPRECATED].includes(lvl)) throwError('ValueError', 'trigger_error(): Argument #2 ($error_level) must be one of E_USER_ERROR, E_USER_WARNING, E_USER_NOTICE, or E_USER_DEPRECATED');
  if (lvl === E_USER_ERROR) {
    if (rt.errorHandlers.length) { const h = rt.errorHandlers[rt.errorHandlers.length - 1]; if (h.handler !== null && (h.mask & lvl)) { const r = callValue(h.handler, [lvl, S(message), rt.file, rt.line]); if (r !== false) return true; } }
    throw new FatalSig(S(message), rt.line, rt.file);
  }
  raise(lvl, S(message));
  return true;
});
alias('user_error', 'trigger_error');
def('error_log', (message, message_type = 0, destination = null) => {
  const t = I(message_type);
  if (t === 3 && destination !== null) { fs.appendFileSync(S(destination), bytes(S(message))); return true; }
  rt.flush(); writeFd(2, bytes(S(message) + '\n')); return true;
});
def('error_get_last', () => {
  if (!rt.lastError) return null;
  return PHPArray.fromPairs([['type', rt.lastError.type], ['message', rt.lastError.message], ['file', rt.lastError.file], ['line', rt.lastError.line]]);
});
def('error_clear_last', () => { rt.lastError = null; });
def('register_shutdown_function', (callback, ...args) => { rt.shutdownFns.push([callback, args]); });
def('assert', (assertion, description = null) => {
  if (rt.ini.get('zend.assertions') !== '1') return true;
  if (toBool(assertion)) return true;
  if (description instanceof PHPObject) throw new ThrowSig(description);
  throwError('AssertionError', description === null ? 'assert(false)' : toStr(description));
});
def('debug_backtrace', (options = 1, limit = 0) => { const t = captureTrace(!(I(options) & 2)); t.delete(0); t.reindex(); const l = I(limit); return l > 0 ? PHPArray.from(t.values().slice(0, l)) : t; });
def('debug_print_backtrace', (options = 0, limit = 0) => { const t = captureTrace(!(I(options) & 2)); t.delete(0); t.reindex(); const s = traceAsString(t); rt.echo(s.slice(0, s.lastIndexOf('#')) ); });
def('gc_collect_cycles', () => 0);
def('gc_enable', () => null); def('gc_disable', () => null); def('gc_enabled', () => true); def('gc_mem_caches', () => 0);
def('set_time_limit', (seconds) => true);
def('ignore_user_abort', (enable = null) => 0);
def('connection_status', () => 0); def('connection_aborted', () => 0);
def('headers_sent', () => false); def('header', (header, replace = true, response_code = 0) => null); def('header_remove', (name = null) => null);
def('headers_list', () => new PHPArray());
def('http_response_code', (response_code = 0) => false);
def('setcookie', (name, ...rest) => true); def('setrawcookie', (name, ...rest) => true);
def('session_start', () => true); def('session_id', () => ''); def('session_destroy', () => true);
def('php_sapi_name', () => 'cli');
def('phpversion', (extension = null) => (extension === null ? PHP_VERSION : (['core', 'standard', 'json', 'ctype', 'mbstring', 'pcre', 'date', 'spl'].includes(S(extension).toLowerCase()) ? PHP_VERSION : false)));
def('php_uname', (mode = 'a') => { const m = S(mode); if (m === 's') return osMod.type(); if (m === 'n') return osMod.hostname(); if (m === 'r') return osMod.release(); if (m === 'm') return osMod.machine ? osMod.machine() : process.arch; if (m === 'v') return osMod.version ? osMod.version() : ''; return `${osMod.type()} ${osMod.hostname()} ${osMod.release()} ${osMod.version ? osMod.version() : ''} ${process.arch}`; });
def('php_ini_loaded_file', () => false);
def('php_ini_scanned_files', () => false);
def('zend_version', () => '4.3.0');
def('extension_loaded', (extension) => ['core', 'standard', 'json', 'ctype', 'mbstring', 'pcre', 'date', 'spl', 'hash', 'random', 'reflection', 'tokenizer', 'iconv', 'filter'].includes(S(extension).toLowerCase()));
def('get_included_files', () => PHPArray.from([...rt.mainFile ? [rt.mainFile] : [], ...rt.included]));
alias('get_required_files', 'get_included_files');
def('get_loaded_extensions', (zend_extensions = false) => PHPArray.from(['Core', 'date', 'json', 'pcre', 'SPL', 'standard', 'ctype', 'mbstring', 'hash', 'random']));
def('dl', () => false);
def('getenv', (name = null, local_only = false) => {
  if (name === null) return PHPArray.fromPairs(Object.entries(process.env).map(([k, v]) => [k, v]));
  const v = process.env[S(name)]; return v === undefined ? false : utf8Encode(v);
});
def('putenv', (assignment) => { const s = S(assignment); const i = s.indexOf('='); if (i < 0) delete process.env[s]; else process.env[s.slice(0, i)] = s.slice(i + 1); return true; });
def('gethostname', () => osMod.hostname());
def('getmypid', () => process.pid);
def('getmyuid', () => (process.getuid ? process.getuid() : 0));
def('get_current_user', () => { try { return osMod.userInfo().username; } catch (e) { return ''; } });
def('memory_get_usage', (real_usage = false) => process.memoryUsage().heapUsed);
def('memory_get_peak_usage', (real_usage = false) => process.memoryUsage().heapTotal);
def('memory_reset_peak_usage', () => null);
def('getrusage', () => { const u = process.cpuUsage(); return PHPArray.fromPairs([['ru_utime.tv_sec', Math.floor(u.user / 1e6)], ['ru_utime.tv_usec', u.user % 1e6], ['ru_stime.tv_sec', Math.floor(u.system / 1e6)], ['ru_stime.tv_usec', u.system % 1e6]]); });
def('sys_getloadavg', () => PHPArray.from(osMod.loadavg().map(mkf)));
def('version_compare', (version1, version2, operator = null) => {
  const canon = (v) => {
    v = v.replace(/[-_+]/g, '.').replace(/([^\d.])(\d)/g, '$1.$2').replace(/(\d)([^\d.])/g, '$1.$2');
    return v.split('.').filter((x) => x !== '');
  };
  const order = (x) => { if (/^\d+$/.test(x)) return 10; const m = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, RC: 3, rc: 3, '#': 4, pl: 5, p: 5 }; return m[x] !== undefined ? m[x] : -1; };
  const a = canon(S(version1)), b = canon(S(version2));
  let r = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) { r = order(y) === 10 || order(y) >= 4 ? -1 : 1; break; }
    if (y === undefined) { r = order(x) === 10 || order(x) >= 4 ? 1 : -1; break; }
    const ox = order(x), oy = order(y);
    if (ox === 10 && oy === 10) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) { r = sgn(d); break; } }
    else if (ox !== oy) { r = sgn(ox - oy); break; }
  }
  if (operator === null) return r;
  switch (S(operator)) {
    case '<': case 'lt': return r < 0; case '<=': case 'le': return r <= 0;
    case '>': case 'gt': return r > 0; case '>=': case 'ge': return r >= 0;
    case '==': case 'eq': return r === 0; case '!=': case '<>': case 'ne': return r !== 0;
  }
  throwError('ValueError', 'version_compare(): Argument #3 ($operator) must be a valid comparison operator');
});

// ---------------------------------------------------------------- output buffering
def('ob_start', (callback = null, chunk_size = 0, flags = 112) => { rt.obStack.push({ buf: '', cb: callback, started: false }); return true; });
function obApply(ob, s, mode) {
  if (ob.cb === null || ob.cb === undefined) return s;
  if (!ob.started) { mode |= 1; ob.started = true; }
  if (ob.inHandler) return s;
  ob.inHandler = true;
  let r;
  try { r = callValue(ob.cb, [s, mode]); } finally { ob.inHandler = false; }
  return r === false ? s : toStr(r);
}
function obEmit(s) { const ob = rt.obStack; if (ob.length) ob[ob.length - 1].buf += s; else rt.echo(s); }
def('ob_get_clean', () => { if (!rt.obStack.length) return false; const ob = rt.obStack[rt.obStack.length - 1]; obApply(ob, ob.buf, 2 | 8); rt.obStack.pop(); return ob.buf; });
def('ob_get_contents', () => (rt.obStack.length ? rt.obStack[rt.obStack.length - 1].buf : false));
def('ob_get_length', () => (rt.obStack.length ? rt.obStack[rt.obStack.length - 1].buf.length : false));
def('ob_get_level', () => rt.obStack.length);
def('ob_end_clean', () => { if (!rt.obStack.length) { notice('ob_end_clean(): Failed to delete buffer. No buffer to delete'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; try { obApply(ob, ob.buf, 2 | 8); } finally { rt.obStack.pop(); } return true; });
def('ob_clean', () => { if (!rt.obStack.length) { notice('ob_clean(): Failed to delete buffer. No buffer to delete'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; obApply(ob, ob.buf, 2); ob.buf = ''; return true; });
def('ob_end_flush', () => { if (!rt.obStack.length) { notice('ob_end_flush(): Failed to delete and flush buffer. No buffer to delete or flush'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; const out = obApply(ob, ob.buf, 8); rt.obStack.pop(); obEmit(out); return true; });
def('ob_get_flush', () => { if (!rt.obStack.length) return false; const ob = rt.obStack[rt.obStack.length - 1]; const out = obApply(ob, ob.buf, 8); rt.obStack.pop(); obEmit(out); return ob.buf; });
def('ob_flush', () => { if (!rt.obStack.length) { notice('ob_flush(): Failed to flush buffer. No buffer to flush'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; const out = obApply(ob, ob.buf, 4); ob.buf = ''; rt.obStack.pop(); obEmit(out); rt.obStack.push(ob); return true; });
def('ob_implicit_flush', (enable = true) => null);
def('ob_list_handlers', () => PHPArray.from(rt.obStack.map((o) => (o.cb ? callableName(o.cb) : 'default output handler'))));
def('ob_get_status', () => new PHPArray());
def('flush', () => { if (!rt.obStack.length) rt.flush(); });
def('output_add_rewrite_var', () => true);

// ---------------------------------------------------------------- JSON
const JSON_ERR_MSG = { 0: 'No error', 1: 'Maximum stack depth exceeded', 2: 'State mismatch (invalid or malformed JSON)', 3: 'Control character error, possibly incorrectly encoded', 4: 'Syntax error', 5: 'Malformed UTF-8 characters, possibly incorrectly encoded', 6: 'Recursion detected', 7: 'Inf and NaN cannot be JSON encoded', 8: 'Type is not supported', 9: 'The decoded property name is invalid', 10: 'Single unpaired UTF-16 surrogate in unicode escape' };
let jsonLastError = 0;
class JsonErr { constructor(code) { this.code = code; } }
let jsonPartialErr = 0;
function jsonFail(flags, code, repl) { if (flags & 512) { jsonPartialErr = code; return repl; } throw new JsonErr(code); }
function jsonStr(s, flags, isKey) {
  let u;
  if (isValidUtf8(s)) u = utf8Decode(s);
  else if (flags & 1048576) u = Buffer.from(s, 'latin1').toString('utf8').replace(/\uFFFD/g, '');
  else if (flags & 2097152) u = Buffer.from(s, 'latin1').toString('utf8');
  else return jsonFail(flags, 5, isKey ? '""' : 'null');
  let out = '"';
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i), ch = u[i];
    switch (ch) {
      case '"': out += (flags & 8) ? '\\u0022' : '\\"'; continue;
      case '\\': out += '\\\\'; continue;
      case '/': out += (flags & 64) ? '/' : '\\/'; continue;
      case '\b': out += '\\b'; continue;
      case '\f': out += '\\f'; continue;
      case '\n': out += '\\n'; continue;
      case '\r': out += '\\r'; continue;
      case '\t': out += '\\t'; continue;
      case '<': if (flags & 1) { out += '\\u003C'; continue; } break;
      case '>': if (flags & 1) { out += '\\u003E'; continue; } break;
      case '&': if (flags & 2) { out += '\\u0026'; continue; } break;
      case "'": if (flags & 4) { out += '\\u0027'; continue; } break;
    }
    if (c < 0x20) { out += '\\u' + c.toString(16).padStart(4, '0'); continue; }
    if (c > 127) {
      if ((flags & 256) && !((c === 0x2028 || c === 0x2029) && !(flags & 2048))) { out += ch; continue; }
      out += '\\u' + c.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  out += '"';
  return (flags & 256) ? utf8Encode(out) : out;
}
function jsonEncode(v, flags, depth, ind, seen) {
  if (depth < 0) throw new JsonErr(1);
  if (v instanceof Ref) v = v.v;
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number': case 'bigint': return String(v);
    case 'string': {
      if (flags & 32) { const n = numericStr(v); if (n !== null && !(n instanceof Flt && !isFinite(n.v))) return jsonEncode(n, flags, depth, ind, seen); }
      return jsonStr(v, flags);
    }
  }
  if (v instanceof Flt) {
    if (!isFinite(v.v)) return jsonFail(flags, 7, '0');
    const s = (flags & 1024) ? fmtReprZ(v.v) : fmtRepr(v.v);
    return s.replace('E', 'e');
  }
  const pretty = (flags & 128) !== 0;
  const nl = pretty ? '\n' : '', pad = pretty ? '    '.repeat(ind + 1) : '', endPad = pretty ? '    '.repeat(ind) : '';
  if (v instanceof PHPArray) {
    if (seen.has(v)) return jsonFail(flags, 6, 'null');
    if (v.size === 0) return (flags & 16) ? '{}' : '[]';
    seen.add(v);
    try {
      if (v.isList() && !(flags & 16)) {
        const parts = v.values().map((x) => pad + jsonEncode(x, flags, depth - 1, ind + 1, seen));
        return '[' + nl + parts.join(',' + nl) + nl + endPad + ']';
      }
      const parts = v.entries().map(([k, x]) => pad + jsonStr(String(k), flags, true) + (pretty ? ': ' : ':') + jsonEncode(x, flags, depth - 1, ind + 1, seen));
      return '{' + nl + parts.join(',' + nl) + nl + endPad + '}';
    } finally { seen.delete(v); }
  }
  if (v instanceof PHPObject) {
    if (v.cls.ancestors.has('jsonserializable')) {
      if (seen.has(v)) return jsonFail(flags, 6, 'null');
      seen.add(v);
      let r;
      try { r = callMethodName(v, 'jsonSerialize', []); } finally { seen.delete(v); }
      if (r !== v) { seen.add(v); try { return jsonEncode(r, flags, depth, ind, seen); } finally { seen.delete(v); } }
    }
    if (v.cls.isEnum) { if (!v.cls.enumBacked) return jsonFail(flags, 8, '0'); return jsonEncode(v.props.get('value'), flags, depth, ind, seen); }
    if (seen.has(v)) return jsonFail(flags, 6, 'null');
    const props = v.cls.nativeToArray ? v.cls.nativeToArray(v).entries() : objVisibleProps(v, null);
    if (!props.length) return '{}';
    seen.add(v);
    try {
      const parts = props.map(([k, x]) => pad + jsonStr(String(k), flags, true) + (pretty ? ': ' : ':') + jsonEncode(x, flags, depth - 1, ind + 1, seen));
      return '{' + nl + parts.join(',' + nl) + nl + endPad + '}';
    } finally { seen.delete(v); }
  }
  return jsonFail(flags, 8, 'null');
}
def('json_encode', (value, flags = 0, depth = 512) => {
  const fl = I(flags);
  try {
    jsonPartialErr = 0;
    const r = jsonEncode(value, fl, I(depth), 0, new Set());
    jsonLastError = jsonPartialErr;
    return r;
  } catch (e) {
    if (!(e instanceof JsonErr)) throw e;
    if (fl & 4194304) { const ex = makeException('JsonException', JSON_ERR_MSG[e.code]); ex.props.set('code', e.code); throw new ThrowSig(ex); }
    jsonLastError = e.code;
    if (fl & 512) return 'null';
    return false;
  }
});
function jsonDecode(text, assoc, maxDepth, flags) {
  const s = text;
  let i = 0;
  const err = (c) => { throw new JsonErr(c || 4); };
  const ws = () => { while (i < s.length) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
  const val = (depth) => {
    if (depth > maxDepth) err(1);
    ws();
    const c = s[i];
    if (c === '{') {
      i++; ws();
      const obj = assoc ? new PHPArray() : new PHPObject(rt.classes.get('stdclass'));
      if (s[i] === '}') { i++; return obj; }
      for (;;) {
        ws(); if (s[i] !== '"') err();
        const k = str();
        ws(); if (s[i] !== ':') err(); i++;
        const v = val(depth + 1);
        if (assoc) obj.set(normKey(k), v); else { if (k.startsWith('\0') && k.length) err(9); obj.props.set(k, v); }
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return obj; }
        err();
      }
    }
    if (c === '[') {
      i++; ws();
      const arr = new PHPArray();
      if (s[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(val(depth + 1));
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        err();
      }
    }
    if (c === '"') return str();
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
    if (!m) err();
    i += m[0].length;
    if (m[1] === undefined && m[2] === undefined) {
      const b = BigInt(m[0]);
      if (b > I64MAX || b < I64MIN) return (flags & 2) ? m[0] : mkf(Number(m[0]));
      return normBig(b);
    }
    return mkf(Number(m[0]));
  };
  const str = () => {
    i++;
    let out = '';
    for (;;) {
      if (i >= s.length) err();
      const c = s[i];
      if (c === '"') { i++; break; }
      if (c === '\\') {
        const e = s[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (map[e] !== undefined) { out += map[e]; i += 2; continue; }
        if (e === 'u') {
          const h = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) err();
          let cp = parseInt(h, 16); i += 6;
          if (cp >= 0xd800 && cp <= 0xdbff) {
            if (s[i] === '\\' && s[i + 1] === 'u') { const lo = parseInt(s.slice(i + 2, i + 6), 16); if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i += 6; } else err(10); }
            else err(10);
          } else if (cp >= 0xdc00 && cp <= 0xdfff) err(10);
          out += String.fromCodePoint(cp); continue;
        }
        err();
      }
      if (c.charCodeAt(0) < 0x20) err(3);
      out += c; i++;
    }
    return utf8Encode(out);
  };
  const r = val(1);
  ws();
  if (i < s.length) err();
  return r;
}
def('json_decode', (json, associative = null, depth = 512, flags = 0) => {
  const fl = I(flags);
  const assoc = associative === null ? (fl & 1) !== 0 : toBool(associative);
  const j = S(json);
  try {
    if (j === '') throw new JsonErr(4);
    if (!isValidUtf8(j)) throw new JsonErr(5);
    const r = jsonDecode(utf8Decode(j), assoc, I(depth), fl);
    jsonLastError = 0;
    return r;
  } catch (e) {
    if (!(e instanceof JsonErr)) throw e;
    if (fl & 4194304) { const ex = makeException('JsonException', JSON_ERR_MSG[e.code]); ex.props.set('code', e.code); throw new ThrowSig(ex); }
    jsonLastError = e.code;
    return null;
  }
});
def('json_last_error', () => jsonLastError);
def('json_last_error_msg', () => JSON_ERR_MSG[jsonLastError] || 'Unknown error');
def('json_validate', (json, depth = 512, flags = 0) => { try { jsonDecode(utf8Decode(S(json)), true, I(depth), 0); jsonLastError = 0; return true; } catch (e) { if (e instanceof JsonErr) { jsonLastError = e.code; return false; } throw e; } });

// ---------------------------------------------------------------- serialize
function serializeVal(v, seen) {
  if (v instanceof Ref) v = v.v;
  if (v === null || v === undefined) return 'N;';
  switch (typeof v) {
    case 'boolean': return `b:${v ? 1 : 0};`;
    case 'number': case 'bigint': return `i:${v};`;
    case 'string': return `s:${v.length}:"${v}";`;
  }
  if (v instanceof Flt) return `d:${fmtRepr(v.v)};`;
  if (v instanceof PHPArray) {
    let s = `a:${v.size}:{`;
    for (const [k, x] of v.entries()) s += serializeVal(k, seen) + serializeVal(x, seen);
    return s + '}';
  }
  if (v instanceof PHPObject) {
    const cn = v.cls.name;
    if (v.cls.isEnum) { const t = cn + ':' + v.props.get('name'); return `E:${t.length}:"${t}";`; }
    if (v.cls === closureClass) throwError('Exception', "Serialization of 'Closure' is not allowed");
    if (v.cls.methods.has('__serialize')) {
      const data = callMethodName(v, '__serialize', []);
      if (!(data instanceof PHPArray)) throwError('TypeError', `${cn}::__serialize() must return an array`);
      let s = `O:${cn.length}:"${cn}":${data.size}:{`;
      for (const [k, x] of data.entries()) s += serializeVal(k, seen) + serializeVal(x, seen);
      return s + '}';
    }
    if (v.cls.ancestors.has('serializable')) {
      const d = callMethodName(v, 'serialize', []);
      if (d === null) return 'N;';
      const ds = toStr(d);
      return `C:${cn.length}:"${cn}":${ds.length}:{${ds}}`;
    }
    let keys = null;
    if (v.cls.methods.has('__sleep')) {
      const r = callMethodName(v, '__sleep', []);
      keys = r instanceof PHPArray ? r.values().map(toStr) : [];
    }
    const entries = [];
    for (const [k, x] of v.props) {
      let sk = k;
      const plain = k.charCodeAt(0) === 0 ? k.slice(k.indexOf('\0', 1) + 1) : k;
      if (keys && !keys.includes(plain)) continue;
      const info = v.cls.props.get(k);
      if (info && info.vis === 'protected') sk = '\0*\0' + k;
      entries.push([sk, x]);
    }
    let s = `O:${cn.length}:"${cn}":${entries.length}:{`;
    for (const [k, x] of entries) s += serializeVal(k, seen) + serializeVal(x, seen);
    return s + '}';
  }
  return 'i:0;';
}
def('serialize', (value) => serializeVal(value, new Set()));
function unserializeVal(s, opts) {
  let i = 0;
  const vals = [];
  const fail = () => { throw new JsonErr(i); };
  const readUntil = (ch) => { const j = s.indexOf(ch, i); if (j < 0) fail(); const r = s.slice(i, j); i = j + 1; return r; };
  const val = () => {
    const t = s[i];
    if (s[i + 1] !== ':' && t !== 'N') fail();
    switch (t) {
      case 'N': i += 2; vals.push(null); return null;
      case 'b': { i += 2; const r = readUntil(';') === '1'; vals.push(r); return r; }
      case 'i': { i += 2; const r = numFromText(readUntil(';')); vals.push(r); return r; }
      case 'd': { i += 2; const t2 = readUntil(';'); const r = mkf(t2 === 'INF' ? Infinity : t2 === '-INF' ? -Infinity : t2 === 'NAN' ? NaN : Number(t2)); vals.push(r); return r; }
      case 's': {
        i += 2; const len = parseInt(readUntil(':'), 10);
        if (s[i] !== '"') fail();
        const r = s.substr(i + 1, len); if (r.length !== len || s[i + 1 + len] !== '"') fail();
        i += len + 3; vals.push(r); return r;
      }
      case 'a': {
        i += 2; const n = parseInt(readUntil(':'), 10);
        if (s[i] !== '{') fail(); i++;
        const a = new PHPArray(); vals.push(a);
        for (let k = 0; k < n; k++) { const key = keyVal(); a.set(normKey(key), val()); }
        if (s[i] !== '}') fail(); i++;
        return a;
      }
      case 'E': {
        i += 2; const len = parseInt(readUntil(':'), 10);
        const t2 = s.substr(i + 1, len); i += len + 3;
        const [cn, cs] = t2.split(':');
        const cls = lookupClass(cn);
        const r = classConst(cls, cs);
        vals.push(r); return r;
      }
      case 'O': case 'C': {
        i += 2; const len = parseInt(readUntil(':'), 10);
        const cn = s.substr(i + 1, len); i += len + 3;
        let cls = classExists(cn, true);
        const allowed = opts.allowed;
        if (allowed === false || (Array.isArray(allowed) && !allowed.includes(cn.toLowerCase()))) cls = rt.classes.get('__php_incomplete_class');
        if (!cls) { cls = rt.classes.get('__php_incomplete_class'); }
        const obj = new PHPObject(cls);
        vals.push(obj);
        if (t === 'C') {
          const dl = parseInt(readUntil(':'), 10);
          const data = s.substr(i + 1, dl); i += dl + 2;
          initProps(obj);
          callMethodName(obj, 'unserialize', [data]);
          return obj;
        }
        const n = parseInt(readUntil(':'), 10);
        if (s[i] !== '{') fail(); i++;
        const data = new PHPArray();
        for (let k = 0; k < n; k++) { const key = keyVal(); data.set(normKey(key), val()); }
        if (s[i] !== '}') fail(); i++;
        if (cls.lname === '__php_incomplete_class') obj.props.set('__PHP_Incomplete_Class_Name', cn);
        if (cls.methods.has('__unserialize')) { initProps(obj); callMethodName(obj, '__unserialize', [data]); }
        else {
          initProps(obj);
          for (const [k, x] of data.entries()) {
            let key = String(k);
            if (key.startsWith('\0*\0')) key = key.slice(3);
            obj.props.set(key, x);
          }
          if (cls.methods.has('__wakeup')) callMethodName(obj, '__wakeup', []);
        }
        return obj;
      }
      case 'r': case 'R': { i += 2; const n = parseInt(readUntil(';'), 10); const r = vals[n - 1]; vals.push(r); return r === undefined ? null : r; }
    }
    fail();
  };
  const keyVal = () => { const n = vals.length; const k = val(); vals.length = n; return k; };
  const r = val();
  return [r, i];
}
def('unserialize', (data, options = null) => {
  const s = S(data);
  const opts = {};
  if (options instanceof PHPArray && options.has('allowed_classes')) {
    const ac = options.get('allowed_classes');
    opts.allowed = ac === true ? true : ac instanceof PHPArray ? ac.values().map((x) => toStr(x).toLowerCase()) : false;
  }
  try {
    const [r] = unserializeVal(s, opts);
    return r;
  } catch (e) {
    if (!(e instanceof JsonErr)) throw e;
    if (s !== 'b:0;') warn(`unserialize(): Error at offset ${e.code} of ${s.length} bytes`);
    return false;
  }
});

// ---------------------------------------------------------------- PCRE
const PREG = { PATTERN_ORDER: 1, SET_ORDER: 2, OFFSET_CAPTURE: 256, UNMATCHED_AS_NULL: 512, SPLIT_NO_EMPTY: 1, SPLIT_DELIM_CAPTURE: 2, SPLIT_OFFSET_CAPTURE: 4, GREP_INVERT: 1 };
let pregLastError = 0;
const PREG_ERR_MSG = { 0: 'No error', 1: 'Internal error', 2: 'Backtrack limit exhausted', 3: 'Recursion limit exhausted', 4: 'Malformed UTF-8 characters, possibly incorrectly encoded', 5: 'The offset did not correspond to the beginning of a valid UTF-8 code point', 6: 'JIT stack limit exhausted' };
const reCache = new Map();
let regexModifiersSupported = false;
try { new RegExp('(?i:a)'); regexModifiersSupported = true; } catch (e) { regexModifiersSupported = false; }
const POSIX_CLASSES = { alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e', ascii: '\\x00-\\x7f' };
const UNICODE_GC = /^(L|Lu|Ll|Lt|Lm|Lo|M|Mn|Mc|Me|N|Nd|Nl|No|P|Pc|Pd|Ps|Pe|Pi|Pf|Po|S|Sm|Sc|Sk|So|Z|Zs|Zl|Zp|C|Cc|Cf|Cs|Co|Cn|L&|Any)$/;

function pregCompile(pattern) {
  let c = reCache.get(pattern);
  if (c !== undefined) return c;
  c = pregCompile0(pattern);
  if (reCache.size > 4096) reCache.clear();
  reCache.set(pattern, c);
  return c;
}
function pregCompile0(pat) {
  const fn = rt.nativeName || 'preg_match';
  let i = 0;
  while (i < pat.length && /\s/.test(pat[i])) i++;
  if (i >= pat.length) { warn(`${fn}(): Empty regular expression`); return null; }
  const d = pat[i];
  if (/[a-zA-Z0-9\\]/.test(d) || d === '\0') { warn(`${fn}(): Delimiter must not be alphanumeric, backslash, or NUL`); return null; }
  const close = { '(': ')', '[': ']', '{': '}', '<': '>' }[d] || d;
  let j = -1;
  if (close === d) {
    for (let k = i + 1; k < pat.length; k++) { if (pat[k] === '\\') { k++; continue; } if (pat[k] === d) { j = k; break; } }
  } else {
    let depth = 1;
    for (let k = i + 1; k < pat.length; k++) {
      if (pat[k] === '\\') { k++; continue; }
      if (pat[k] === d) depth++;
      else if (pat[k] === close) { depth--; if (depth === 0) { j = k; break; } }
    }
  }
  if (j < 0) { warn(`${fn}(): No ending ${close === d ? '' : 'matching '}delimiter '${close}' found`); return null; }
  let body = pat.slice(i + 1, j);
  const mods = pat.slice(j + 1).replace(/[\r\n ]+$/, '');
  const fl = { i: false, m: false, s: false, x: false, u: false, U: false, D: false, A: false, n: false };
  for (const m of mods) {
    if (m in fl) fl[m] = true;
    else if (m === 'S' || m === 'X' || m === 'J') continue;
    else { warn(`${fn}(): Unknown modifier '${m}'`); return null; }
  }
  if (close !== d) { /* bracket delimiters: inner delimiter chars are literal */ }
  else if (d !== '/') body = body.split('\\' + d).join(/[.*+?^${}()|[\]\\/]/.test(d) ? '\\' + d : d);
  let unicode = fl.u;
  if (!unicode && /\\[pPX]/.test(body)) unicode = true;
  let src;
  const names = [null];
  try { src = translatePcre(unicode ? utf8Decode(body) : body, fl, names, unicode); }
  catch (e) { if (e instanceof PcreErr) { warn(`${fn}(): Compilation failed: ${e.msg} at offset ${e.off}`); return null; } throw e; }
  let jsFlags = 'g';
  if (fl.i) jsFlags += 'i';
  if (fl.m) jsFlags += 'm';
  if (fl.s) jsFlags += 's';
  if (unicode) jsFlags += 'u';
  if (fl.A) src = '(?:' + src + ')';
  let re, reD;
  try { re = new RegExp(src, jsFlags); }
  catch (e) { warn(`${fn}(): Compilation failed: ${e.message.replace(/^Invalid regular expression: /, '')} at offset 0`); return null; }
  return { re, src, flags: jsFlags, names, unicode, anchored: fl.A, getD() { return reD || (reD = new RegExp(src, jsFlags + 'd')); } };
}
class PcreErr { constructor(msg, off) { this.msg = msg; this.off = off; } }
function translatePcre(p, fl, names, unicode) {
  groupStack.length = 0; pendingClose.length = 0; globalNeedsI.flag = false;
  let out = '';
  let i = 0;
  const n = p.length;
  let groupCount = 0;
  const esc = (ch) => (/[\^$\\.*+?()[\]{}|/\-]/.test(ch) ? '\\' + ch : ch);
  const litChar = (ch) => {
    const c = ch.codePointAt(0);
    if (/[\^$\\.*+?()[\]{}|/]/.test(ch)) return '\\' + ch;
    if (c < 32 || (c >= 127 && c < 256 && !unicode)) return '\\x' + c.toString(16).padStart(2, '0');
    return ch;
  };
  // handle leading inline flags (?i) etc
  let m;
  while ((m = /^\(\?([imsxUnJ]*)(?:-([imsx]*))?\)/.exec(p.slice(i)))) {
    for (const f of m[1]) { if (f === 'i') fl.i = true; else if (f === 'm') fl.m = true; else if (f === 's') fl.s = true; else if (f === 'x') fl.x = true; else if (f === 'U') fl.U = true; }
    for (const f of m[2] || '') { if (f === 'i') fl.i = false; else if (f === 'm') fl.m = false; else if (f === 's') fl.s = false; else if (f === 'x') fl.x = false; }
    i += m[0].length;
  }
  const parseEscape = (inClass) => {
    // p[i] === '\\'
    const e = p[i + 1];
    if (e === undefined) throw new PcreErr('\\ at end of pattern', i);
    i += 2;
    switch (e) {
      case 'w': if (unicode) return inClass ? '\\p{L}\\p{N}_' : '[\\p{L}\\p{N}_]'; return '\\w';
      case 'W': if (unicode && !inClass) return '[^\\p{L}\\p{N}_]'; return '\\W';
      case 'd': if (unicode) return '\\p{Nd}'; return '\\d';
      case 'D': if (unicode) return '\\P{Nd}'; return '\\D';
      case 'b': if (unicode && !inClass) return '(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))'; return '\\b';
      case 'B': if (unicode && !inClass) return '(?:(?<=[\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))'; return '\\B';
      case 's': case 'S': case 'n': case 'r': case 't': case 'f': return '\\' + e;
      case 'v': return inClass ? '\\n\\x0B\\f\\r\\x85\\u2028\\u2029' : '[\\n\\x0B\\f\\r\\x85\\u2028\\u2029]';
      case 'V': return '[^\\n\\x0B\\f\\r\\x85\\u2028\\u2029]';
      case 'h': return inClass ? '\\t \\xA0' : '[\\t \\xA0]';
      case 'H': return '[^\\t \\xA0]';
      case 'R': return '(?:\\r\\n|\\n|\\x0B|\\f|\\r|\\x85)';
      case 'A': return '(?<![\\s\\S])';
      case 'z': return '(?![\\s\\S])';
      case 'Z': return '(?=\\n?(?![\\s\\S]))';
      case 'G': return '';
      case 'K': throw new PcreErr('\\K is not supported', i);
      case 'e': return '\\x1b';
      case 'a': return '\\x07';
      case '0': {
        const mm = /^[0-7]{0,2}/.exec(p.slice(i));
        i += mm[0].length;
        return '\\x' + parseInt('0' + mm[0], 8).toString(16).padStart(2, '0');
      }
      case 'x': {
        if (p[i] === '{') { const end = p.indexOf('}', i); const hex = p.slice(i + 1, end); i = end + 1; const cp = parseInt(hex, 16); return unicode ? '\\u{' + cp.toString(16) + '}' : (cp < 256 ? '\\x' + cp.toString(16).padStart(2, '0') : '\\u' + cp.toString(16).padStart(4, '0')); }
        const mm = /^[0-9a-fA-F]{0,2}/.exec(p.slice(i)); i += mm[0].length;
        return '\\x' + (mm[0] || '0').padStart(2, '0');
      }
      case 'o': { const end = p.indexOf('}', i); const oct = p.slice(i + 1, end); i = end + 1; return '\\u{' + parseInt(oct, 8).toString(16) + '}'; }
      case 'c': { const ch = p[i++]; return '\\c' + ch.toUpperCase(); }
      case 'p': case 'P': {
        let name;
        if (p[i] === '{') { const end = p.indexOf('}', i); name = p.slice(i + 1, end); i = end + 1; }
        else { name = p[i]; i++; }
        let negate = e === 'P';
        if (name[0] === '^') { negate = !negate; name = name.slice(1); }
        if (name === 'L&') name = 'LC';
        if (name === 'Any') return negate ? '[^\\s\\S]' : '[\\s\\S]';
        if (name === 'Xan') return negate ? '[^\\p{L}\\p{N}]' : (inClass ? '\\p{L}\\p{N}' : '[\\p{L}\\p{N}]');
        if (name === 'Xwd') return negate ? '[^\\p{L}\\p{N}_]' : (inClass ? '\\p{L}\\p{N}_' : '[\\p{L}\\p{N}_]');
        if (name === 'Xsp' || name === 'Xps') return negate ? '\\S' : '\\s';
        const prop = UNICODE_GC.test(name) || name === 'LC' ? name : 'Script=' + name;
        return (negate ? '\\P{' : '\\p{') + prop + '}';
      }
      case 'X': return '(?:\\P{M}\\p{M}*)';
      case 'Q': {
        const end = p.indexOf('\\E', i);
        const lit = end < 0 ? p.slice(i) : p.slice(i, end);
        i = end < 0 ? n : end + 2;
        return lit.split('').map(inClass ? (ch) => (/[\]\\^-]/.test(ch) ? '\\' + ch : ch) : litChar).join('');
      }
      case 'E': return '';
      case 'g': {
        let ref;
        if (p[i] === '{') { const end = p.indexOf('}', i); ref = p.slice(i + 1, end); i = end + 1; }
        else if (p[i] === '<' || p[i] === "'") { const cl = p[i] === '<' ? '>' : "'"; const end = p.indexOf(cl, i + 1); ref = p.slice(i + 1, end); i = end + 1; throw new PcreErr('subroutine calls are not supported', i); }
        else { const mm = /^-?\d+/.exec(p.slice(i)); ref = mm[0]; i += mm[0].length; }
        if (/^-?\d+$/.test(ref)) { let num = parseInt(ref, 10); if (num < 0) num = groupCount + 1 + num; return '\\' + num; }
        return '\\k<' + ref + '>';
      }
      case 'k': {
        const op = p[i]; const cl = op === '{' ? '}' : op === '<' ? '>' : "'";
        const end = p.indexOf(cl, i + 1); const name = p.slice(i + 1, end); i = end + 1;
        return '\\k<' + name + '>';
      }
      default:
        if (e >= '1' && e <= '9') {
          const mm = /^\d*/.exec(p.slice(i)); i += mm[0].length;
          if (inClass) return '\\x' + parseInt(e + mm[0], 8).toString(16).padStart(2, '0');
          return '\\' + e + mm[0];
        }
        if (/[a-zA-Z]/.test(e)) {
          if (inClass && e === 'N') throw new PcreErr('\\N is not supported in a class', i);
          if (e === 'N') return '[^\\n]';
          return e; // unknown alpha escape: literal
        }
        if (inClass) return /[\]\\^\-[]/.test(e) ? '\\' + e : litChar(e);
        return litChar(e);
    }
  };
  while (i < n) {
    const ch = p[i];
    if (fl.x) {
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '#') { while (i < n && p[i] !== '\n') i++; continue; }
    }
    if (ch === '\\') { out += parseEscape(false); continue; }
    if (ch === '[') {
      let cls = '[';
      i++;
      if (p[i] === '^') { cls += '^'; i++; }
      if (p[i] === ']') { cls += '\\]'; i++; }
      while (i < n && p[i] !== ']') {
        if (p[i] === '[' && p[i + 1] === ':') {
          const end = p.indexOf(':]', i);
          if (end > 0) {
            let name = p.slice(i + 2, end); let neg = false;
            if (name[0] === '^') { neg = true; name = name.slice(1); }
            const pc = POSIX_CLASSES[name];
            if (!pc) throw new PcreErr('unknown POSIX class name', i);
            if (neg) { if (name === 'digit') cls += '\\D'; else if (name === 'space') cls += '\\S'; else if (name === 'word') cls += '\\W'; else throw new PcreErr('negated POSIX classes are not supported', i); }
            else cls += pc;
            i = end + 2; continue;
          }
        }
        if (p[i] === '\\') { cls += parseEscape(true); continue; }
        if (p[i] === '[') { cls += '\\['; i++; continue; }
        const c2 = p[i];
        const cc = c2.codePointAt(0);
        cls += (cc < 32 || (cc >= 127 && cc < 256 && !unicode)) ? '\\x' + cc.toString(16).padStart(2, '0') : c2;
        i += c2.length;
      }
      if (i >= n) throw new PcreErr('missing terminating ] for character class', i);
      i++;
      out += cls + ']';
      continue;
    }
    if (ch === '(') {
      if (p[i + 1] === '?') {
        const rest = p.slice(i + 2, i + 40);
        let mm;
        if (rest[0] === '#') { const end = p.indexOf(')', i); i = end + 1; continue; }
        if ((mm = /^P?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest)) || (mm = /^'([A-Za-z_][A-Za-z0-9_]*)'/.exec(rest))) {
          groupCount++; names[groupCount] = mm[1];
          out += '(?<' + mm[1] + '>'; i += 2 + mm[0].length; continue;
        }
        if ((mm = /^P=([A-Za-z_][A-Za-z0-9_]*)\)/.exec(rest))) { out += '\\k<' + mm[1] + '>'; i += 2 + mm[0].length; continue; }
        if (/^P>|^R\)|^\d+\)|^[+-]\d+\)|^&/.test(rest)) throw new PcreErr('recursive patterns are not supported', i);
        if (rest[0] === '>') { out += '(?:'; i += 3; continue; }
        if (rest[0] === '|') { out += '(?:'; i += 3; continue; }
        if (rest[0] === ':' || rest[0] === '=' || rest[0] === '!') { out += '(?' + rest[0]; i += 3; continue; }
        if (rest.startsWith('<=') || rest.startsWith('<!')) { out += '(?' + rest.slice(0, 2); i += 4; continue; }
        if ((mm = /^([imsxUnJ]*)(?:-([imsx]*))?(:|\))/.exec(rest))) {
          // inline modifiers
          const on = mm[1].replace(/[UnJx]/g, ''), off = (mm[2] || '').replace(/x/g, '');
          if (mm[1].includes('x')) fl.x = true;
          if (mm[3] === ')') {
            // applies to rest of group; approximate by wrapping remaining group content
            if (regexModifiersSupported && (on || off)) {
              out += '(?' + on + (off ? '-' + off : '') + ':';
              i += 2 + mm[0].length;
              // find end of enclosing group -> we close at end of pattern/group via depth tracking
              pendingClose.push(depthNow());
              continue;
            }
            if (on.includes('i') && !fl.i) globalNeedsI.flag = true;
            i += 2 + mm[0].length; continue;
          }
          if (regexModifiersSupported && (on || off)) out += '(?' + on + (off ? '-' + off : '') + ':';
          else out += '(?:';
          if (!regexModifiersSupported && on.includes('i')) globalNeedsI.flag = true;
          i += 2 + mm[0].length;
          groupStack.push(false);
          continue;
        }
        throw new PcreErr('unrecognized character after (? or (?-', i + 2);
      }
      if (p[i + 1] === '*') throw new PcreErr('(*VERB) not supported', i);
      if (fl.n) { out += '(?:'; i++; groupStack.push(false); continue; }
      groupCount++;
      out += '(';
      i++;
      groupStack.push(true);
      continue;
    }
    if (ch === ')') {
      // close any pending inline-modifier groups opened at this depth
      while (pendingClose.length && pendingClose[pendingClose.length - 1] === depthNow()) { out += ')'; pendingClose.pop(); }
      groupStack.pop();
      out += ')'; i++;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      let q = ch;
      if (ch === '{') {
        const mm = /^\{(\d*)(?:,(\d*))?\}/.exec(p.slice(i));
        if (!mm || (mm[1] === '' && mm[2] === undefined)) { out += '\\{'; i++; continue; }
        q = mm[1] === '' ? '{0,' + mm[2] + '}' : mm[0];
        i += mm[0].length;
      } else i++;
      let lazy = false;
      if (p[i] === '?') { lazy = true; i++; }
      else if (p[i] === '+') { i++; } // possessive -> greedy (approximation)
      if (fl.U) lazy = !lazy;
      out += q + (lazy ? '?' : '');
      continue;
    }
    if (ch === '.') { out += fl.s ? '.' : (unicode ? '[^\\n]' : '[^\\n]'); i++; continue; }
    if (ch === '$') { out += fl.m ? '(?=\\n|(?![\\s\\S]))' : (fl.D ? '(?![\\s\\S])' : '(?=\\n?(?![\\s\\S]))'); i++; continue; }
    if (ch === '^') { out += fl.m ? '(?<=^|\\n)' : '(?<![\\s\\S])'; i++; continue; }
    if (ch === '}' || ch === ']') { out += '\\' + ch; i++; continue; }
    if (ch === '/') { out += '\\/'; i++; continue; }
    const cc = ch.codePointAt(0);
    if (cc < 32 || (cc >= 127 && cc < 256 && !unicode)) { out += '\\x' + cc.toString(16).padStart(2, '0'); i++; continue; }
    out += ch; i += ch.length;
  }
  while (pendingClose.length) { out += ')'; pendingClose.pop(); }
  if (groupStack.length) throw new PcreErr('missing closing parenthesis', n);
  if (globalNeedsI.flag) { fl.i = true; globalNeedsI.flag = false; }
  void esc;
  return out;
  function depthNow() { return groupStack.length; }
}
const groupStack = [];
const pendingClose = [];
const globalNeedsI = { flag: false };

// helper converting JS string indexes to byte offsets in unicode mode
function offsetMapper(ustr, unicode) {
  if (!unicode) return (idx) => idx;
  let lastIdx = 0, lastByte = 0;
  return (idx) => {
    if (idx < lastIdx) { lastIdx = 0; lastByte = 0; }
    lastByte += Buffer.byteLength(ustr.slice(lastIdx, idx), 'utf8');
    lastIdx = idx;
    return lastByte;
  };
}
function byteToIndex(ustr, byteOff) {
  if (byteOff <= 0) return 0;
  const b = Buffer.from(ustr, 'utf8').subarray(0, byteOff);
  return b.toString('utf8').length;
}
function pregSubject(c, subject) {
  if (!c.unicode) return subject;
  if (!isValidUtf8(subject)) { pregLastError = 4; return null; }
  return utf8Decode(subject);
}
const enc = (c, s) => (c.unicode && s !== undefined && s !== null ? utf8Encode(s) : s);
function buildMatchArray(c, m, flags, omap, trimTrailing) {
  const offCap = (flags & 256) !== 0, unNull = (flags & 512) !== 0;
  const out = new PHPArray();
  let last = m.length - 1;
  if (trimTrailing && !unNull) while (last > 0 && m[last] === undefined) last--;
  for (let g = 0; g <= last; g++) {
    let v = m[g];
    let val = v === undefined ? (unNull ? null : '') : enc(c, v);
    if (offCap) {
      const off = v === undefined ? -1 : omap(m.indices[g][0]);
      val = PHPArray.from([val, off]);
    }
    const name = c.names[g];
    if (name) out.set(name, val instanceof PHPArray ? val.clone() : val);
    out.set(g, val);
  }
  return out;
}
def('preg_match', (pattern, subject, matches = undefined, flags = 0, offset = 0) => {
  const c = pregCompile(S(pattern)); if (!c) return false;
  pregLastError = 0;
  const subj = pregSubject(c, S(subject)); if (subj === null) return false;
  const fl = I(flags);
  const re = (fl & 256) ? c.getD() : c.re;
  let off = I(offset); if (off < 0) off = Math.max(0, S(subject).length + off);
  re.lastIndex = c.unicode ? byteToIndex(subj, off) : off;
  const m = re.exec(subj);
  if (!m || (c.anchored && m.index !== re.lastIndex - m[0].length && m.index !== (c.unicode ? byteToIndex(subj, off) : off))) { if (matches instanceof Ref) matches.v = new PHPArray(); return 0; }
  if (matches instanceof Ref) matches.v = buildMatchArray(c, m, fl, offsetMapper(subj, c.unicode), true);
  return 1;
}, { refs: [false, false, true] });
function* pregIter(c, subj, re, off) {
  re.lastIndex = off;
  let m;
  while ((m = re.exec(subj))) {
    if (c.anchored && m.index !== off) break;
    yield m;
    if (m[0] === '') { re.lastIndex = m.index + (c.unicode && subj.codePointAt(m.index) > 0xffff ? 2 : 1); if (re.lastIndex > subj.length) break; }
    off = re.lastIndex;
  }
}
def('preg_match_all', (pattern, subject, matches = undefined, flags = 0, offset = 0) => {
  const c = pregCompile(S(pattern)); if (!c) return false;
  pregLastError = 0;
  const subj = pregSubject(c, S(subject)); if (subj === null) return false;
  let fl = I(flags);
  const order = (fl & 2) ? 2 : 1;
  const re = (fl & 256) ? c.getD() : c.re;
  const omap = offsetMapper(subj, c.unicode);
  let off = I(offset); if (off < 0) off = Math.max(0, S(subject).length + off);
  const all = [...pregIter(c, subj, re, c.unicode ? byteToIndex(subj, off) : off)];
  if (matches instanceof Ref) {
    if (order === 2) {
      matches.v = PHPArray.from(all.map((m) => buildMatchArray(c, m, fl, omap, true)));
    } else {
      const ngroups = new RegExp(c.src + '|', c.flags.replace('g', '')).exec('').length;
      const out = new PHPArray();
      for (let g = 0; g < ngroups; g++) {
        const list = new PHPArray();
        for (const m of all) {
          const v = m[g];
          let val = v === undefined ? ((fl & 512) ? null : '') : enc(c, v);
          if (fl & 256) val = PHPArray.from([val, v === undefined ? -1 : omap(m.indices[g][0])]);
          list.push(val);
        }
        if (c.names[g]) out.set(c.names[g], list.clone());
        out.set(g, list);
      }
      matches.v = out;
    }
  }
  return all.length;
}, { refs: [false, false, true] });
function expandReplacement(rep, m, c) {
  return rep.replace(/\\(\d{1,2})|\$(\d{1,2})|\$\{(\d{1,2})\}|\\\\/g, (all, a, b, d) => {
    if (all === '\\\\') return '\\';
    const g = parseInt(a || b || d, 10);
    const v = m[g];
    return v === undefined ? '' : enc(c, v);
  });
}
function pregReplaceOne(c, subj, repFn, limit, counter) {
  const u = pregSubject(c, subj); if (u === null) return null;
  let out = '', last = 0, n = 0;
  for (const m of pregIter(c, u, c.re, 0)) {
    if (limit >= 0 && n >= limit) break;
    out += enc(c, u.slice(last, m.index)) + repFn(m);
    last = m.index + m[0].length;
    n++;
  }
  counter.n += n;
  return out + enc(c, u.slice(last));
}
function pregReplaceImpl(pattern, replacement, subject, limit, count, isCb, flags) {
  pregLastError = 0;
  const lim = I(limit);
  const counter = { n: 0 };
  const pats = pattern instanceof PHPArray ? pattern.values().map(toStr) : [S(pattern)];
  const reps = !isCb && replacement instanceof PHPArray ? replacement.values().map(toStr) : null;
  const doOne = (s) => {
    s = toStr(s);
    for (let i = 0; i < pats.length; i++) {
      const c = pregCompile(pats[i]); if (!c) return null;
      let fn;
      if (isCb) { const cb = callableFn(replacement); fn = (m) => toStr(cb(buildMatchArray(c, m, flags || 0, (x) => x, true))); }
      else { const rep = reps ? (i < reps.length ? reps[i] : '') : toStr(replacement); fn = (m) => expandReplacement(rep, m, c); }
      s = pregReplaceOne(c, s, fn, lim, counter);
      if (s === null) return null;
    }
    return s;
  };
  let r;
  if (subject instanceof PHPArray) { r = new PHPArray(); for (const [k, v] of subject.entries()) { const x = doOne(v); if (x !== null) r.set(k, x); } }
  else r = doOne(subject);
  if (count instanceof Ref) count.v = counter.n;
  return r;
}
def('preg_replace', (pattern, replacement, subject, limit = -1, count = undefined) => pregReplaceImpl(pattern, replacement, subject, limit, count, false), { refs: [false, false, false, false, true] });
def('preg_filter', (pattern, replacement, subject, limit = -1, count = undefined) => pregReplaceImpl(pattern, replacement, subject, limit, count, false), { refs: [false, false, false, false, true] });
def('preg_replace_callback', (pattern, callback, subject, limit = -1, count = undefined, flags = 0) => pregReplaceImpl(pattern, callback, subject, limit, count, true, I(flags)), { refs: [false, false, false, false, true] });
def('preg_replace_callback_array', (pattern, subject, limit = -1, count = undefined, flags = 0) => {
  let s = subject; let total = 0;
  for (const [p, cb] of A(pattern).entries()) { const cnt = new Ref(0); s = pregReplaceImpl(String(p), cb, s, limit, cnt, true, I(flags)); total += cnt.v; }
  if (count instanceof Ref) count.v = total;
  return s;
}, { refs: [false, false, false, true] });
def('preg_split', (pattern, subject, limit = -1, flags = 0) => {
  const c = pregCompile(S(pattern)); if (!c) return false;
  pregLastError = 0;
  const raw = S(subject);
  const subj = pregSubject(c, raw); if (subj === null) return false;
  let lim = limit === null ? -1 : I(limit); if (lim === 0) lim = -1;
  const fl = I(flags);
  const noEmpty = (fl & 1) !== 0, delim = (fl & 2) !== 0, offCap = (fl & 4) !== 0;
  const omap = offsetMapper(subj, c.unicode);
  const out = new PHPArray();
  const add = (s, idx) => {
    if (noEmpty && s === '') return;
    const v = enc(c, s);
    out.push(offCap ? PHPArray.from([v, omap(idx)]) : v);
  };
  let last = 0;
  const re = c.getD();
  for (const m of pregIter(c, subj, re, 0)) {
    if (lim > 0 && out.size >= lim - 1) break;
    if (m[0] === '' && m.index === last && (m.index === 0 || m.index >= subj.length)) { if (m.index >= subj.length) break; continue; }
    if (m[0] === '' && m.index === last && noEmpty) continue;
    add(subj.slice(last, m.index), last);
    if (delim) for (let g = 1; g < m.length; g++) if (m[g] !== undefined && !(noEmpty && m[g] === '')) add(m[g], m.indices[g][0]);
    last = m.index + m[0].length;
  }
  add(subj.slice(last), last);
  return out;
});
def('preg_quote', (str, delimiter = null) => {
  const d = delimiter === null ? '' : S(delimiter);
  return S(str).replace(/[\s\S]/g, (ch) => {
    if (ch === '\0') return '\\000';
    if ('.\\+*?[^]$(){}=!<>|:-#/'.includes(ch) && (ch !== '/' || d === '/') ) return '\\' + ch;
    if (d && ch === d) return '\\' + ch;
    return ch;
  });
});
def('preg_grep', (pattern, array, flags = 0) => {
  const c = pregCompile(S(pattern)); if (!c) return false;
  const inv = (I(flags) & 1) !== 0;
  const out = new PHPArray();
  for (const [k, v] of A(array).entries()) {
    const s = pregSubject(c, toStr(v)); if (s === null) continue;
    c.re.lastIndex = 0;
    const hit = c.re.test(s);
    if (hit !== inv) out.set(k, v);
  }
  return out;
});
def('preg_last_error', () => pregLastError);
def('preg_last_error_msg', () => PREG_ERR_MSG[pregLastError] || 'Unknown error');

// ---------------------------------------------------------------- date / time
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const tzFmtCache = new Map();
function validTz(tz) {
  if (/^(utc|gmt|z)$/i.test(tz)) return true;
  if (/^[+-]\d{2}:?\d{2}$/.test(tz)) return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
function tzInfo(ts, tz) {
  const ms = Math.floor(ts) * 1000;
  let m;
  if (!tz || /^(utc|gmt|z)$/i.test(tz) || (m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz))) {
    const off = m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60) : 0;
    const d = new Date(ms + off * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay(), offset: off, abbr: m ? (m[1] + m[2] + ':' + m[3]) : 'UTC', dst: 0 };
  }
  let fmt = tzFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', timeZoneName: 'short', era: 'short' });
    tzFmtCache.set(tz, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  let y = parseInt(parts.year, 10); if (parts.era === 'BC' || parts.era === 'B') y = 1 - y;
  const r = { y, mo: parseInt(parts.month, 10), d: parseInt(parts.day, 10), h: parseInt(parts.hour, 10) % 24, mi: parseInt(parts.minute, 10), s: parseInt(parts.second, 10) };
  const asUtc = utcMs(r.y, r.mo, r.d, r.h, r.mi, r.s);
  r.offset = Math.round((asUtc - ms) / 1000);
  r.dow = new Date(asUtc).getUTCDay();
  let ab = parts.timeZoneName || '';
  if (/^GMT[+-]/.test(ab)) { const alt = tzAbbrGB(tz, ms); if (alt && !/^GMT[+-]|^UTC[+-]/.test(alt)) ab = alt; }
  const gm = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(ab);
  if (gm) ab = gm[1] + gm[2].padStart(2, '0') + (gm[3] ? gm[3] : '');
  else if (ab === 'GMT' && tz !== 'Europe/London' && tz !== 'GMT') ab = r.offset === 0 ? 'GMT' : ab;
  r.abbr = ab;
  // DST detection: compare with standard offset (min of Jan/Jul)
  const jan = tzOffsetAt(utcMs(r.y, 1, 1, 0, 0, 0), tz), jul = tzOffsetAt(utcMs(r.y, 7, 1, 0, 0, 0), tz);
  r.dst = r.offset > Math.min(jan, jul) ? 1 : 0;
  return r;
}
const tzGBCache = new Map();
function tzAbbrGB(tz, ms) {
  let f = tzGBCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }); tzGBCache.set(tz, f); }
  const p = f.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName');
  return p ? p.value : null;
}
function tzOffsetAt(ms, tz) {
  let fmt = tzFmtCache.get(tz);
  if (!fmt) { tzInfo(ms / 1000, tz); fmt = tzFmtCache.get(tz); }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  let y = parseInt(parts.year, 10); if (parts.era === 'BC' || parts.era === 'B') y = 1 - y;
  return Math.round((utcMs(y, parseInt(parts.month, 10), parseInt(parts.day, 10), parseInt(parts.hour, 10) % 24, parseInt(parts.minute, 10), parseInt(parts.second, 10)) - ms) / 1000);
}
function utcMs(y, mo, d, h, mi, s) { const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d); dt.setUTCHours(h, mi, s, 0); return dt.getTime(); }
function localToTs(y, mo, d, h, mi, s, tz) {
  const guess = utcMs(y, mo, d, h, mi, s) / 1000;
  const off1 = tzInfo(guess, tz).offset;
  let ts = guess - off1;
  const off2 = tzInfo(ts, tz).offset;
  if (off2 !== off1) ts = guess - off2;
  return ts;
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
function isoWeek(y, mo, d) {
  const dt = new Date(utcMs(y, mo, d, 0, 0, 0));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow + 3);
  const wy = dt.getUTCFullYear();
  const firstThu = new Date(utcMs(wy, 1, 4, 0, 0, 0));
  const fdow = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fdow + 3);
  return [wy, 1 + Math.round((dt - firstThu) / 604800000)];
}
function phpDate(format, ts, tz, micro) {
  const t = tzInfo(ts, tz);
  const p2 = (n) => String(n).padStart(2, '0');
  const offStr = (sep) => { const o = t.offset; const s = o < 0 ? '-' : '+'; const a = Math.abs(o); return s + p2(Math.floor(a / 3600)) + sep + p2(Math.floor((a % 3600) / 60)); };
  const doy = Math.round((utcMs(t.y, t.mo, t.d, 0, 0, 0) - utcMs(t.y, 1, 1, 0, 0, 0)) / 86400000);
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    switch (c) {
      case 'd': out += p2(t.d); break;
      case 'D': out += DAY_NAMES[t.dow].slice(0, 3); break;
      case 'j': out += t.d; break;
      case 'l': out += DAY_NAMES[t.dow]; break;
      case 'N': out += t.dow === 0 ? 7 : t.dow; break;
      case 'S': out += (t.d % 10 === 1 && t.d !== 11) ? 'st' : (t.d % 10 === 2 && t.d !== 12) ? 'nd' : (t.d % 10 === 3 && t.d !== 13) ? 'rd' : 'th'; break;
      case 'w': out += t.dow; break;
      case 'z': out += doy; break;
      case 'W': out += p2(isoWeek(t.y, t.mo, t.d)[1]); break;
      case 'F': out += MONTH_NAMES[t.mo - 1]; break;
      case 'm': out += p2(t.mo); break;
      case 'M': out += MONTH_NAMES[t.mo - 1].slice(0, 3); break;
      case 'n': out += t.mo; break;
      case 't': out += daysInMonth(t.y, t.mo); break;
      case 'L': out += isLeap(t.y) ? 1 : 0; break;
      case 'o': out += isoWeek(t.y, t.mo, t.d)[0]; break;
      case 'X': case 'x': out += (t.y < 0 ? '-' : (c === 'X' || t.y >= 10000 ? '+' : '')) + String(Math.abs(t.y)).padStart(4, '0'); break;
      case 'Y': out += (t.y < 0 ? '-' : '') + String(Math.abs(t.y)).padStart(4, '0'); break;
      case 'y': out += p2(Math.abs(t.y) % 100); break;
      case 'a': out += t.h < 12 ? 'am' : 'pm'; break;
      case 'A': out += t.h < 12 ? 'AM' : 'PM'; break;
      case 'B': { const b = Math.floor((((ts + 3600) % 86400) + 86400) % 86400 / 86.4); out += String(b).padStart(3, '0'); break; }
      case 'g': out += (t.h % 12) || 12; break;
      case 'G': out += t.h; break;
      case 'h': out += p2((t.h % 12) || 12); break;
      case 'H': out += p2(t.h); break;
      case 'i': out += p2(t.mi); break;
      case 's': out += p2(t.s); break;
      case 'u': out += String(micro || 0).padStart(6, '0'); break;
      case 'v': out += String(Math.floor((micro || 0) / 1000)).padStart(3, '0'); break;
      case 'e': out += tz; break;
      case 'I': out += t.dst; break;
      case 'O': out += offStr(''); break;
      case 'P': out += offStr(':'); break;
      case 'p': out += t.offset === 0 ? 'Z' : offStr(':'); break;
      case 'T': out += /^[A-Z]/.test(t.abbr) ? t.abbr : offStr(':').replace(/:00$/, '').replace(':', ''); break;
      case 'Z': out += t.offset; break;
      case 'c': out += phpDate('Y-m-d\\TH:i:sP', ts, tz); break;
      case 'r': out += phpDate('D, d M Y H:i:s O', ts, tz); break;
      case 'U': out += Math.floor(ts); break;
      case '\\': i++; if (i < format.length) out += format[i]; break;
      default: out += c;
    }
  }
  return out;
}
const nowTs = () => Math.floor(Date.now() / 1000);
def('time', () => nowTs());
def('microtime', (as_float = false) => {
  const t = performance.timeOrigin + performance.now();
  if (toBool(as_float)) return mkf(t / 1000);
  const sec = Math.floor(t / 1000); const us = (t / 1000 - sec);
  return us.toFixed(8) + ' ' + sec;
});
def('hrtime', (as_number = false) => {
  const t = process.hrtime.bigint();
  if (toBool(as_number)) return normBig(t);
  return PHPArray.from([Number(t / 1000000000n), Number(t % 1000000000n)]);
});
def('date', (format, timestamp = null) => phpDate(S(format), timestamp === null ? nowTs() : I(timestamp), rt.tz));
def('gmdate', (format, timestamp = null) => phpDate(S(format), timestamp === null ? nowTs() : I(timestamp), 'UTC'));
def('idate', (format, timestamp = null) => toInt(phpDate(S(format) === 'y' ? 'y' : S(format), timestamp === null ? nowTs() : I(timestamp), rt.tz)));
function mktimeImpl(args, tz) {
  const t = tzInfo(nowTs(), tz);
  const g = (i, d) => (args[i] === undefined || args[i] === null ? d : toInt(args[i]));
  let y = g(5, t.y);
  if (args[5] !== undefined && args[5] !== null) { if (y >= 0 && y < 70) y += 2000; else if (y >= 70 && y <= 100) y += 1900; }
  return localToTs(y, g(3, t.mo), g(4, t.d), g(0, t.h), g(1, t.mi), g(2, t.s), tz);
}
def('mktime', (hour = null, minute = null, second = null, month = null, day = null, year = null) => mktimeImpl([hour, minute, second, month, day, year], rt.tz));
def('gmmktime', (hour = null, minute = null, second = null, month = null, day = null, year = null) => mktimeImpl([hour, minute, second, month, day, year], 'UTC'));
def('checkdate', (month, day, year) => { const m = I(month), d = I(day), y = I(year); return m >= 1 && m <= 12 && d >= 1 && y >= 1 && y <= 32767 && d <= daysInMonth(y, m); });
def('date_default_timezone_set', (timezoneId) => { const tz = S(timezoneId); if (!validTz(tz)) { notice(`date_default_timezone_set(): Timezone ID '${tz}' is invalid`); return false; } rt.tz = tz; return true; });
def('date_default_timezone_get', () => rt.tz);
def('getdate', (timestamp = null) => {
  const ts = timestamp === null ? nowTs() : I(timestamp); const t = tzInfo(ts, rt.tz);
  const doy = Math.round((utcMs(t.y, t.mo, t.d, 0, 0, 0) - utcMs(t.y, 1, 1, 0, 0, 0)) / 86400000);
  return PHPArray.fromPairs([['seconds', t.s], ['minutes', t.mi], ['hours', t.h], ['mday', t.d], ['wday', t.dow], ['mon', t.mo], ['year', t.y], ['yday', doy], ['weekday', DAY_NAMES[t.dow]], ['month', MONTH_NAMES[t.mo - 1]], [0, ts]]);
});
def('localtime', (timestamp = null, associative = false) => {
  const ts = timestamp === null ? nowTs() : I(timestamp); const t = tzInfo(ts, rt.tz);
  const doy = Math.round((utcMs(t.y, t.mo, t.d, 0, 0, 0) - utcMs(t.y, 1, 1, 0, 0, 0)) / 86400000);
  const vals = [t.s, t.mi, t.h, t.d, t.mo - 1, t.y - 1900, t.dow, doy, t.dst];
  if (!toBool(associative)) return PHPArray.from(vals);
  return PHPArray.fromPairs(['tm_sec', 'tm_min', 'tm_hour', 'tm_mday', 'tm_mon', 'tm_year', 'tm_wday', 'tm_yday', 'tm_isdst'].map((k, i) => [k, vals[i]]));
});
def('cal_days_in_month', (calendar, month, year) => daysInMonth(I(year), I(month)));
def('strftime', (format, timestamp = null) => {
  const ts = timestamp === null ? nowTs() : I(timestamp);
  const map = { a: 'D', A: 'l', d: 'd', e: 'j', j: 'z', u: 'N', w: 'w', U: 'W', V: 'W', W: 'W', b: 'M', B: 'F', h: 'M', m: 'm', y: 'y', Y: 'Y', G: 'o', H: 'H', I: 'h', l: 'g', M: 'i', p: 'A', P: 'a', r: 'h:i:s A', R: 'H:i', S: 's', T: 'H:i:s', X: 'H:i:s', z: 'O', Z: 'T', c: 'D M j H:i:s Y', D: 'm/d/y', F: 'Y-m-d', s: 'U', x: 'm/d/y', n: '\n', t: '\t', '%': '%' };
  return S(format).replace(/%([a-zA-Z%])/g, (m, c) => (map[c] ? (c === 'n' || c === 't' || c === '%' ? map[c] : (c === 'e' ? phpDate('j', ts, rt.tz).padStart(2, ' ') : phpDate(map[c], ts, rt.tz))) : m));
});
alias('gmstrftime', 'strftime');
def('usleep', (microseconds) => { rt.flush(); sleepMs(I(microseconds) / 1000); });
def('sleep', (seconds) => { rt.flush(); sleepMs(I(seconds) * 1000); return 0; });
def('time_nanosleep', (seconds, nanoseconds) => { rt.flush(); sleepMs(I(seconds) * 1000 + I(nanoseconds) / 1e6); return true; });
def('time_sleep_until', (timestamp) => { rt.flush(); sleepMs(N(timestamp) * 1000 - Date.now()); return true; });
def('gettimeofday', (as_float = false) => {
  const t = Date.now();
  if (toBool(as_float)) return mkf(t / 1000);
  return PHPArray.fromPairs([['sec', Math.floor(t / 1000)], ['usec', (t % 1000) * 1000], ['minuteswest', -tzInfo(t / 1000, rt.tz).offset / 60], ['dsttime', 0]]);
});

const MONTHS_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS_RE = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const monthNum = (s) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase()) + 1;
const dayNum = (s) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(s.slice(0, 3).toLowerCase());
const REL_UNITS = { sec: 's', secs: 's', second: 's', seconds: 's', min: 'mi', mins: 'mi', minute: 'mi', minutes: 'mi', hour: 'h', hours: 'h', day: 'd', days: 'd', week: 'w', weeks: 'w', fortnight: 'f', fortnights: 'f', month: 'mo', months: 'mo', year: 'y', years: 'y', weekday: 'wd', weekdays: 'wd', msec: 'ms', millisecond: 'ms', milliseconds: 'ms', usec: 'us', microsecond: 'us', microseconds: 'us' };
function strToTime(input, base, tz) {
  let s = input.trim().toLowerCase();
  if (s === '') return false;
  const b = tzInfo(base, tz);
  let y = b.y, mo = b.mo, d = b.d, h = b.h, mi = b.mi, sec = b.s;
  let timeSet = false, dateSet = false, absTs = null, zoneOff = null, zone = null;
  const rel = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0, wd: 0 };
  let weekday = null, weekdayDir = 0, firstLast = null;
  const tzFromStr = (z) => {
    if (z === 'z' || z === 'utc' || z === 'gmt') return 0;
    const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(z);
    if (m) return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0));
    return null;
  };
  const setTime = (H, M, S2, ampm) => {
    H = parseInt(H, 10); M = M ? parseInt(M, 10) : 0; S2 = S2 ? parseInt(S2, 10) : 0;
    if (ampm) { const pm = ampm[0] === 'p'; if (H === 12) H = pm ? 12 : 0; else if (pm) H += 12; }
    h = H; mi = M; sec = S2; timeSet = true;
  };
  const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, next: 1, last: -1, previous: -1, this: 0 };
  const pats = [
    [/^@(-?\d+)(?:\.\d+)?/, (m) => { absTs = parseInt(m[1], 10); }],
    [/^(now)\b/, () => {}],
    [/^(today|midnight)\b/, () => { h = mi = sec = 0; timeSet = true; }],
    [/^noon\b/, () => { h = 12; mi = sec = 0; timeSet = true; }],
    [/^tomorrow\b/, () => { rel.d += 1; h = mi = sec = 0; timeSet = true; }],
    [/^yesterday\b/, () => { rel.d -= 1; h = mi = sec = 0; timeSet = true; }],
    [/^(\d{4})-(\d{1,2})-(\d{1,2})[t ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; setTime(m[4], m[5], m[6]); }],
    [/^(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; }],
    [/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; }],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/, (m) => { mo = +m[1]; d = +m[2]; y = +m[3]; if (m[3].length === 2) y += y < 70 ? 2000 : 1900; dateSet = true; }],
    [/^(\d{1,2})\/(\d{1,2})\b/, (m) => { mo = +m[1]; d = +m[2]; dateSet = true; }],
    [/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})\b/, (m) => { d = +m[1]; mo = +m[2]; y = +m[3]; dateSet = true; }],
    [/^(\d{4})(\d{2})(\d{2})(?:t?(\d{2}):?(\d{2}):?(\d{2}))?(?!\d)/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; if (m[4]) setTime(m[4], m[5], m[6]); }],
    [new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[ \\-.]*(${MONTHS_RE})\\.?(?:[ \\-.,]+(\\d{4}))?\\b`), (m) => { d = +m[1]; mo = monthNum(m[2]); if (m[3]) y = +m[3]; dateSet = true; }],
    [new RegExp(`^(${MONTHS_RE})\\.?[ \\-.]*(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\-.]*(\\d{4}))?\\b`), (m) => { mo = monthNum(m[1]); d = +m[2]; if (m[3]) y = +m[3]; dateSet = true; }],
    [new RegExp(`^(${MONTHS_RE})\\.?[ \\-.]*(\\d{4})\\b`), (m) => { mo = monthNum(m[1]); y = +m[2]; d = 1; dateSet = true; }],
    [new RegExp(`^(${MONTHS_RE})\\b`), (m) => { mo = monthNum(m[1]); dateSet = true; }],
    [/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([ap]\.?m\.?)?/, (m) => { setTime(m[1], m[2], m[3], m[5] ? m[5].replace(/\./g, '') : null); }],
    [/^(\d{1,2})\s*([ap]\.?m\.?)/, (m) => { setTime(m[1], 0, 0, m[2].replace(/\./g, '')); }],
    [/^t(\d{2}):?(\d{2}):?(\d{2})?/, (m) => setTime(m[1], m[2], m[3])],
    [/^(first|last) day of\b/, (m) => { firstLast = m[1]; }],
    [new RegExp(`^(next|last|previous|this)\\s+(${DAYS_RE})\\b`), (m) => { weekday = dayNum(m[2]); weekdayDir = m[1] === 'next' ? 1 : m[1] === 'this' ? 0 : -1; }],
    [/^(next|last|previous|this)\s+(sec|second|min|minute|hour|day|week|fortnight|month|year)\b/, (m) => { const n = NUMW[m[1]]; addRel(n, m[2]); }],
    [/^([+-]?\s*\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(secs?|seconds?|mins?|minutes?|hours?|days?|weeks?|fortnights?|months?|years?|weekdays?|msec|milliseconds?|usec|microseconds?)\b/, (m) => { const n = NUMW[m[1]] !== undefined ? NUMW[m[1]] : parseInt(m[1].replace(/\s+/g, ''), 10); addRel(n, m[2]); }],
    [/^ago\b/, () => { for (const k of Object.keys(rel)) rel[k] = -rel[k]; }],
    [new RegExp(`^(${DAYS_RE})\\b`), (m) => { weekday = dayNum(m[1]); weekdayDir = 0; }],
    [/^(z|utc|gmt)\b/, (m) => { zoneOff = 0; }],
    [/^([+-]\d{2}):?(\d{2})\b/, (m) => { zoneOff = tzFromStr(m[1] + m[2]); }],
    [/^([a-z]+\/[a-z_]+(?:\/[a-z_]+)?)/, (m) => { const zn = input.trim().slice(input.trim().toLowerCase().indexOf(m[1]), input.trim().toLowerCase().indexOf(m[1]) + m[1].length); if (validTz(zn)) zone = zn; else throw new Error('bad'); }],
    [/^(\d{4})\b/, (m) => { if (timeSet || dateSet) { y = +m[1]; } else { setTime(m[1].slice(0, 2), m[1].slice(2)); } }],
    [/^[\s,]+/, () => {}],
  ];
  function addRel(n, unit) {
    const u = REL_UNITS[unit] || REL_UNITS[unit.replace(/s$/, '')];
    if (u === 'w') rel.d += 7 * n; else if (u === 'f') rel.d += 14 * n; else if (u === 'wd') rel.wd += n; else if (u === 'ms' || u === 'us') { /* ignore sub-second */ } else rel[u] += n;
  }
  let pos = 0;
  try {
    while (pos < s.length) {
      const rest = s.slice(pos);
      let matched = false;
      for (const [re, fn] of pats) {
        const m = re.exec(rest);
        if (m && m[0].length) { fn(m); pos += m[0].length; matched = true; break; }
      }
      if (!matched) return false;
    }
  } catch (e) { return false; }
  if (absTs !== null) {
    const t2 = tzInfo(absTs, 'UTC');
    y = t2.y; mo = t2.mo; d = t2.d; h = t2.h; mi = t2.mi; sec = t2.s; zoneOff = 0;
  }
  if (dateSet && !timeSet) { h = mi = sec = 0; }
  y += rel.y; mo += rel.mo;
  // normalize month
  while (mo > 12) { mo -= 12; y++; }
  while (mo < 1) { mo += 12; y--; }
  if (firstLast === 'first') d = 1;
  else if (firstLast === 'last') d = daysInMonth(y, mo);
  if (firstLast && !timeSet) { h = mi = sec = 0; }
  d += rel.d; h += rel.h; mi += rel.mi; sec += rel.s;
  if (weekday !== null) {
    const cur = new Date(utcMs(y, mo, d, 0, 0, 0)).getUTCDay();
    let diff = (weekday - cur + 7) % 7;
    if (weekdayDir === 1 && diff === 0) diff = 7;
    if (weekdayDir === -1) { diff = diff === 0 ? -7 : diff - 7; }
    d += diff;
    if (!timeSet) { h = mi = sec = 0; }
  }
  if (rel.wd) {
    let n = rel.wd; const step = n > 0 ? 1 : -1;
    while (n !== 0) { d += step; const wd = new Date(utcMs(y, mo, d, 0, 0, 0)).getUTCDay(); if (wd !== 0 && wd !== 6) n -= step; }
  }
  if (zoneOff !== null) return Math.floor(utcMs(y, mo, d, h, mi, sec) / 1000) - zoneOff;
  return localToTs(y, mo, d, h, mi, sec, zone || tz);
}
def('strtotime', (datetime, baseTimestamp = null) => strToTime(S(datetime), baseTimestamp === null ? nowTs() : I(baseTimestamp), rt.tz));
def('date_parse', (datetime) => {
  const ts = strToTime(S(datetime), nowTs(), rt.tz);
  const out = new PHPArray();
  if (ts === false) { out.set('error_count', 1); return out; }
  const t = tzInfo(ts, rt.tz);
  for (const [k, v] of [['year', t.y], ['month', t.mo], ['day', t.d], ['hour', t.h], ['minute', t.mi], ['second', t.s], ['fraction', mkf(0)], ['warning_count', 0], ['warnings', new PHPArray()], ['error_count', 0], ['errors', new PHPArray()], ['is_localtime', false]]) out.set(k, v);
  return out;
});
def('__tz_info', (ts, tz) => { const t = tzInfo(I(ts), S(tz)); return PHPArray.fromPairs([['offset', t.offset], ['abbr', t.abbr], ['dst', t.dst], ['y', t.y], ['m', t.mo], ['d', t.d], ['h', t.h], ['i', t.mi], ['s', t.s], ['dow', t.dow]]); });
def('__date_tz', (format, ts, tz, micro = 0) => phpDate(S(format), I(ts), S(tz), I(micro)));
def('__strtotime_tz', (str, base, tz) => strToTime(S(str), I(base), S(tz)));
def('__local_to_ts', (y, m, d, h, i, s, tz) => localToTs(I(y), I(m), I(d), I(h), I(i), I(s), S(tz)));
def('__valid_tz', (tz) => validTz(S(tz)));

// ---------------------------------------------------------------- files & streams
class StreamH {
  constructor(kind, fd, path, mode) {
    this.kind = kind; this.fd = fd; this.path = path; this.mode = mode;
    this.pos = 0; this.eof = false; this.rbuf = ''; this.mem = ''; this.append = mode[0] === 'a';
    this.readable = /r|\+/.test(mode); this.writable = /[waxc]|\+/.test(mode);
    this.dirEntries = null;
  }
}
function getStream(v) {
  if (v instanceof Ref) v = v.v;
  if (!(v instanceof PHPResource) || v.type !== 'stream') throwError('TypeError', `${rt.nativeName}(): Argument #1 ($stream) must be of type resource, ${typeOf(v)} given`);
  if (v.closed) throwError('TypeError', `${rt.nativeName}(): supplied resource is not a valid stream resource`);
  return v.h;
}
function mkStream(kind, fd, path, mode) { return new PHPResource('stream', new StreamH(kind, fd, path, mode)); }
let STDIN_R, STDOUT_R, STDERR_R;
function rawRead(h, n) {
  if (h.kind === 'mem') { const r = h.mem.slice(h.pos, h.pos + n); h.pos += r.length; if (h.pos >= h.mem.length) h.eof = r.length < n || h.pos >= h.mem.length; return r; }
  if (h.kind === 'output') return '';
  const buf = Buffer.alloc(n);
  let got;
  for (;;) {
    try { got = fs.readSync(h.fd, buf, 0, n, h.kind === 'file' ? h.pos : null); break; }
    catch (e) { if (e.code === 'EAGAIN') { sleepMs(5); continue; } if (e.code === 'EOF') { got = 0; break; } throw e; }
  }
  if (h.kind === 'file') h.pos += got;
  return buf.toString('latin1', 0, got);
}
function fillBuf(h, want) {
  while (h.rbuf.length < want) {
    const chunk = rawRead(h, Math.max(8192, want - h.rbuf.length));
    if (chunk === '') return false;
    h.rbuf += chunk;
  }
  return true;
}
function streamReadLine(h, maxLen) {
  if (h.kind === 'stdio' && h.fd === 0) rt.flush();
  for (;;) {
    const nl = h.rbuf.indexOf('\n');
    if (nl >= 0 && (maxLen === null || nl + 1 <= maxLen)) { const line = h.rbuf.slice(0, nl + 1); h.rbuf = h.rbuf.slice(nl + 1); return line; }
    if (maxLen !== null && h.rbuf.length >= maxLen) { const line = h.rbuf.slice(0, maxLen); h.rbuf = h.rbuf.slice(maxLen); return line; }
    const chunk = h.kind === 'stdio' ? rawRead(h, 65536) : rawRead(h, 8192);
    if (chunk === '') {
      h.eof = true;
      if (h.rbuf === '') return false;
      const line = h.rbuf; h.rbuf = ''; return line;
    }
    h.rbuf += chunk;
  }
}
function streamRead(h, n) {
  if (h.kind === 'stdio' && h.fd === 0) rt.flush();
  if (h.rbuf.length < n) {
    const more = rawRead(h, Math.max(n - h.rbuf.length, h.kind === 'file' ? n - h.rbuf.length : 1));
    if (more === '') h.eof = true;
    h.rbuf += more;
  }
  const r = h.rbuf.slice(0, n); h.rbuf = h.rbuf.slice(n);
  if (h.kind === 'mem' && h.pos >= h.mem.length && !h.rbuf) h.eof = true;
  return r;
}
function streamWrite(stream, data) {
  const h = getStream(stream);
  const s = toStr(data);
  if (h.kind === 'output') { rt.echo(s); return s.length; }
  if (h.kind === 'mem') {
    if (h.append) h.pos = h.mem.length;
    h.mem = h.mem.slice(0, h.pos) + s + h.mem.slice(h.pos + s.length);
    h.pos += s.length; return s.length;
  }
  if (h.kind === 'stdio') { rt.flush(); writeFd(h.fd, Buffer.from(s, 'latin1')); return s.length; }
  if (!h.writable) { notice(`fwrite(): Write of ${s.length} bytes failed with errno=9 Bad file descriptor`); return false; }
  const buf = Buffer.from(s, 'latin1');
  if (h.append) { fs.writeSync(h.fd, buf, 0, buf.length, null); h.pos = fs.fstatSync(h.fd).size; }
  else { fs.writeSync(h.fd, buf, 0, buf.length, h.pos - h.rbuf.length); h.pos = h.pos - h.rbuf.length + buf.length; h.rbuf = ''; }
  return buf.length;
}
function openStream(filename, mode) {
  const fn = filename;
  if (fn === 'php://stdin') return STDIN_R;
  if (fn === 'php://stdout') return mkStream('stdio', 1, fn, 'w');
  if (fn === 'php://stderr') return mkStream('stdio', 2, fn, 'w');
  if (fn === 'php://output') return mkStream('output', -1, fn, 'w');
  if (fn === 'php://memory' || fn.startsWith('php://temp')) return mkStream('mem', -1, fn, 'w+');
  if (fn === 'php://input') return mkStream('mem', -1, fn, 'r');
  if (/^(https?|ftp):\/\//i.test(fn)) { warn(`fopen(${fn}): Failed to open stream: network streams are not supported`); return false; }
  let p = fn.replace(/^file:\/\//, '');
  const m = mode.replace(/[bt]/g, '');
  const flagsMap = { r: 'r', 'r+': 'r+', w: 'w', 'w+': 'w+', a: 'a', 'a+': 'a+', x: 'wx', 'x+': 'wx+', c: fs.constants.O_WRONLY | fs.constants.O_CREAT, 'c+': fs.constants.O_RDWR | fs.constants.O_CREAT };
  if (!(m in flagsMap)) throwError('ValueError', `${rt.nativeName}(): Argument #2 ($mode) must be a valid mode`);
  try {
    const fd = fs.openSync(p, flagsMap[m]);
    const r = mkStream('file', fd, p, m);
    if (m[0] === 'a') r.h.pos = fs.fstatSync(fd).size;
    return r;
  } catch (e) {
    const msg = e.code === 'ENOENT' ? 'No such file or directory' : e.code === 'EACCES' ? 'Permission denied' : e.code === 'EEXIST' ? 'File exists' : e.code === 'EISDIR' ? 'Is a directory' : e.message;
    warn(`${rt.nativeName}(${fn}): Failed to open stream: ${msg}`);
    return false;
  }
}
def('fopen', (filename, mode, use_include_path = false, context = null) => openStream(S(filename), S(mode)));
def('fclose', (stream) => { const v = deref(stream); const h = getStream(v); if (h.kind === 'file') { try { fs.closeSync(h.fd); } catch (e) { /* ignore */ } } v.closed = true; return true; });
def('fgets', (stream, length = null) => { const h = getStream(stream); return streamReadLine(h, length === null ? null : Math.max(0, I(length) - 1)); });
def('fgetc', (stream) => { const h = getStream(stream); const c = streamRead(h, 1); return c === '' ? false : c; });
def('fread', (stream, length) => { const h = getStream(stream); const n = I(length); if (n <= 0) throwError('ValueError', 'fread(): Argument #2 ($length) must be greater than 0'); return streamRead(h, n); });
def('fwrite', (stream, data, length = null) => { let s = S(data); if (length !== null) s = s.slice(0, I(length)); return streamWrite(stream, s); });
alias('fputs', 'fwrite');
def('feof', (stream) => {
  const h = getStream(stream);
  if (h.rbuf.length) return false;
  if (h.kind === 'mem') return h.pos >= h.mem.length && h.eof;
  if (h.kind === 'file') { try { return h.eof || h.pos >= fs.fstatSync(h.fd).size && h.eof; } catch (e) { return true; } }
  return h.eof;
});
def('fflush', (stream) => { getStream(stream); rt.flush(); return true; });
def('ftell', (stream) => { const h = getStream(stream); return h.pos - h.rbuf.length; });
def('fseek', (stream, offset, whence = 0) => {
  const h = getStream(stream); const off = I(offset); const w = I(whence);
  const size = h.kind === 'mem' ? h.mem.length : h.kind === 'file' ? fs.fstatSync(h.fd).size : 0;
  const cur = h.pos - h.rbuf.length;
  const np = w === 0 ? off : w === 1 ? cur + off : size + off;
  if (np < 0) return -1;
  h.pos = np; h.rbuf = ''; h.eof = false;
  return 0;
});
def('rewind', (stream) => { const h = getStream(stream); h.pos = 0; h.rbuf = ''; h.eof = false; return true; });
def('ftruncate', (stream, size) => { const h = getStream(stream); if (h.kind === 'mem') { h.mem = h.mem.slice(0, I(size)).padEnd(I(size), '\0'); return true; } fs.ftruncateSync(h.fd, I(size)); return true; });
def('flock', (stream, operation, would_block = undefined) => true, { refs: [false, false, true] });
def('fstat', (stream) => { const h = getStream(stream); if (h.kind === 'mem') return PHPArray.fromPairs([['size', h.mem.length]]); return statArray(fs.fstatSync(h.fd)); });
def('stream_get_contents', (stream, length = null, offset = -1) => {
  const h = getStream(stream);
  if (I(offset) >= 0) { h.pos = I(offset); h.rbuf = ''; }
  let out = h.rbuf; h.rbuf = '';
  const lim = length === null ? Infinity : I(length);
  for (;;) { if (out.length >= lim) break; const c = rawRead(h, 65536); if (c === '') { h.eof = true; break; } out += c; }
  if (out.length > lim) { h.rbuf = out.slice(lim); out = out.slice(0, lim); }
  return out;
});
def('stream_get_line', (stream, length, ending = '') => {
  const h = getStream(stream); const e = S(ending);
  if (!e) return streamRead(h, I(length)) || false;
  for (;;) {
    const p = h.rbuf.indexOf(e);
    if (p >= 0) { const r = h.rbuf.slice(0, p); h.rbuf = h.rbuf.slice(p + e.length); return r; }
    const c = rawRead(h, 8192); if (c === '') { if (!h.rbuf) { h.eof = true; return false; } const r = h.rbuf; h.rbuf = ''; h.eof = true; return r; }
    h.rbuf += c;
  }
});
def('stream_get_meta_data', (stream) => { const h = getStream(stream); return PHPArray.fromPairs([['timed_out', false], ['blocked', true], ['eof', h.eof], ['wrapper_type', h.kind === 'file' ? 'plainfile' : 'PHP'], ['stream_type', h.kind === 'mem' ? 'MEMORY' : 'STDIO'], ['mode', h.mode], ['unread_bytes', 0], ['seekable', h.kind !== 'stdio'], ['uri', h.path]]); });
def('stream_isatty', (stream) => { const h = getStream(stream); try { return h.kind === 'stdio' && require('tty').isatty(h.fd); } catch (e) { return false; } });
alias('posix_isatty', 'stream_isatty');
def('stream_set_blocking', (stream, enable) => true);
def('stream_set_timeout', (stream, seconds, microseconds = 0) => true);
def('stream_context_create', (options = null, params = null) => new PHPResource('stream-context', {}));
def('stream_select', (read, write, except, seconds, microseconds = 0) => { const r = deref(read); return r instanceof PHPArray ? r.size : 0; }, { refs: [true, true, true] });
def('stream_get_wrappers', () => PHPArray.from(['php', 'file']));
def('fpassthru', (stream) => { const s = callNative(rt.fns.get('stream_get_contents'), [stream]); rt.echo(s); return s.length; });
def('fgetcsv', (stream, length = null, separator = ',', enclosure = '"', escape = '\\') => {
  const h = getStream(stream);
  let line = streamReadLine(h, null);
  if (line === false) return false;
  const sep = S(separator), encl = S(enclosure);
  // multi-line quoted fields
  while ((line.split(encl).length - 1) % 2 === 1) { const more = streamReadLine(h, null); if (more === false) break; line += more; }
  line = line.replace(/\r?\n$/, '');
  if (line === '') return PHPArray.from([null]);
  return PHPArray.from(parseCsvLine(line, sep, encl, S(escape)));
});
function parseCsvLine(line, sep, encl, escape) {
  const out = []; let cur = '', inQ = false, i = 0, quotedField = false;
  while (i < line.length) {
    const c = line[i];
    if (inQ) {
      if (escape && c === escape && escape !== encl && line[i + 1] === encl) { cur += c + encl; i += 2; continue; }
      if (c === encl) { if (line[i + 1] === encl) { cur += encl; i += 2; continue; } inQ = false; i++; continue; }
      cur += c; i++; continue;
    }
    if (c === encl && cur.trim() === '' ) { inQ = true; quotedField = true; cur = ''; i++; continue; }
    if (c === sep) { out.push(cur); cur = ''; quotedField = false; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  void quotedField;
  return out;
}
function csvLine(fields, sep, encl, eol) {
  return fields.map((f) => {
    const s = toStr(f);
    if (s === '' ) return s;
    if (/[\s"\\,;]/.test(s) || s.includes(sep) || s.includes(encl)) return encl + s.split(encl).join(encl + encl) + encl;
    return s;
  }).join(sep) + eol;
}
def('fputcsv', (stream, fields, separator = ',', enclosure = '"', escape = '\\', eol = '\n') => streamWrite(stream, csvLine(A(fields).values(), S(separator), S(enclosure), S(eol))));
def('str_getcsv', (string, separator = ',', enclosure = '"', escape = '\\') => PHPArray.from(parseCsvLine(S(string), S(separator), S(enclosure), S(escape))));
def('readline', (prompt = null) => {
  if (prompt !== null) { rt.echo(S(prompt)); }
  rt.flush();
  const l = streamReadLine(STDIN_R.h, null);
  if (l === false) return false;
  return l.replace(/\r?\n$/, '');
});
def('readline_add_history', (prompt) => true);
def('readline_clear_history', () => true);
def('readline_write_history', () => true);
def('readline_read_history', () => true);

function fsErr(fn, p, e) {
  const msg = e.code === 'ENOENT' ? 'No such file or directory' : e.code === 'EACCES' ? 'Permission denied' : e.code === 'EEXIST' ? 'File exists' : e.code === 'ENOTEMPTY' ? 'Directory not empty' : e.code === 'EISDIR' ? 'Is a directory' : e.code === 'ENOTDIR' ? 'Not a directory' : e.message;
  return msg;
}
def('file_get_contents', (filename, use_include_path = false, context = null, offset = 0, length = null) => {
  const fn = S(filename);
  if (fn === 'php://stdin') { let out = STDIN_R.h.rbuf; STDIN_R.h.rbuf = ''; for (;;) { const c = rawRead(STDIN_R.h, 65536); if (c === '') break; out += c; } return out; }
  if (fn === 'php://input') return '';
  if (/^https?:\/\//i.test(fn)) {
    try { return fromBytes(cpMod.execFileSync('curl', ['-sSL', '--fail', fn], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 })); }
    catch (e) { warn(`file_get_contents(${fn}): Failed to open stream: HTTP request failed!`); return false; }
  }
  if (fn.startsWith('data:')) { const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(fn); if (m) return m[1] ? fromBytes(Buffer.from(m[2], 'base64')) : decodeURIComponent(m[2]); }
  try {
    let data = fs.readFileSync(fn.replace(/^file:\/\//, '')).toString('latin1');
    const off = I(offset);
    if (off) data = data.slice(off < 0 ? data.length + off : off);
    if (length !== null) data = data.slice(0, I(length));
    return data;
  } catch (e) {
    warn(`file_get_contents(${fn}): Failed to open stream: ${fsErr('file_get_contents', fn, e)}`);
    return false;
  }
});
def('file_put_contents', (filename, data, flags = 0, context = null) => {
  const fn = S(filename);
  let s;
  if (data instanceof PHPArray) s = data.values().map(toStr).join('');
  else if (data instanceof PHPResource) s = callNative(rt.fns.get('stream_get_contents'), [data]);
  else s = toStr(data);
  if (fn === 'php://stdout' || fn === 'php://output') { if (fn === 'php://output') rt.echo(s); else { rt.flush(); writeFd(1, bytes(s)); } return s.length; }
  if (fn === 'php://stderr') { rt.flush(); writeFd(2, bytes(s)); return s.length; }
  try {
    if (I(flags) & 8) fs.appendFileSync(fn, bytes(s)); else fs.writeFileSync(fn, bytes(s));
    return s.length;
  } catch (e) {
    warn(`file_put_contents(${fn}): Failed to open stream: ${fsErr('', fn, e)}`);
    return false;
  }
});
def('file', (filename, flags = 0, context = null) => {
  const c = callNative(rt.fns.get('file_get_contents'), [filename]);
  if (c === false) return false;
  const fl = I(flags);
  let lines = c.split(/(?<=\n)/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (fl & 2) lines = lines.map((l) => l.replace(/\r?\n$/, ''));
  if (fl & 4) lines = lines.filter((l) => l !== '');
  return PHPArray.from(lines);
});
def('readfile', (filename) => { const c = callNative(rt.fns.get('file_get_contents'), [filename]); if (c === false) return false; rt.echo(c); return c.length; });
const statOk = (p, fn) => { try { return fn(fs.statSync(p)); } catch (e) { return false; } };
def('file_exists', (filename) => { try { fs.accessSync(S(filename)); return true; } catch (e) { return false; } });
def('is_file', (filename) => statOk(S(filename), (s) => s.isFile()));
def('is_dir', (filename) => statOk(S(filename), (s) => s.isDirectory()));
def('is_link', (filename) => { try { return fs.lstatSync(S(filename)).isSymbolicLink(); } catch (e) { return false; } });
def('is_readable', (filename) => { try { fs.accessSync(S(filename), fs.constants.R_OK); return true; } catch (e) { return false; } });
def('is_writable', (filename) => { try { fs.accessSync(S(filename), fs.constants.W_OK); return true; } catch (e) { return false; } });
alias('is_writeable', 'is_writable');
def('is_executable', (filename) => { try { fs.accessSync(S(filename), fs.constants.X_OK); return statOk(S(filename), (s) => s.isFile()); } catch (e) { return false; } });
def('is_uploaded_file', (filename) => false);
def('move_uploaded_file', (from, to) => false);
function statFn(name, get) { def(name, (filename) => { try { return get(fs.statSync(S(filename))); } catch (e) { warn(`${name}(): stat failed for ${S(filename)}`); return false; } }); }
statFn('filesize', (s) => s.size);
statFn('filemtime', (s) => Math.floor(s.mtimeMs / 1000));
statFn('fileatime', (s) => Math.floor(s.atimeMs / 1000));
statFn('filectime', (s) => Math.floor(s.ctimeMs / 1000));
statFn('fileperms', (s) => s.mode);
statFn('fileinode', (s) => s.ino);
statFn('fileowner', (s) => s.uid);
statFn('filegroup', (s) => s.gid);
statFn('filetype', (s) => (s.isFile() ? 'file' : s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : s.isFIFO() ? 'fifo' : s.isCharacterDevice() ? 'char' : s.isBlockDevice() ? 'block' : 'unknown'));
function statArray(s) {
  const vals = [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.rdev, s.size, Math.floor(s.atimeMs / 1000), Math.floor(s.mtimeMs / 1000), Math.floor(s.ctimeMs / 1000), s.blksize, s.blocks];
  const names = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'atime', 'mtime', 'ctime', 'blksize', 'blocks'];
  const out = PHPArray.from(vals);
  names.forEach((n, i) => out.set(n, vals[i]));
  return out;
}
def('stat', (filename) => { try { return statArray(fs.statSync(S(filename))); } catch (e) { warn(`stat(): stat failed for ${S(filename)}`); return false; } });
def('lstat', (filename) => { try { return statArray(fs.lstatSync(S(filename))); } catch (e) { warn(`lstat(): Lstat failed for ${S(filename)}`); return false; } });
def('clearstatcache', (clear_realpath_cache = false, filename = '') => null);
def('touch', (filename, mtime = null, atime = null) => {
  const p = S(filename);
  try { if (!fs.existsSync(p)) fs.writeFileSync(p, ''); const mt = mtime === null ? Date.now() / 1000 : I(mtime); fs.utimesSync(p, atime === null ? mt : I(atime), mt); return true; }
  catch (e) { warn(`touch(): Unable to create file ${p} because ${fsErr('', p, e)}`); return false; }
});
def('unlink', (filename, context = null) => { const p = S(filename); try { fs.unlinkSync(p); return true; } catch (e) { warn(`unlink(${p}): ${fsErr('', p, e)}`); return false; } });
def('mkdir', (directory, permissions = 0o777, recursive = false, context = null) => { const p = S(directory); try { fs.mkdirSync(p, { recursive: toBool(recursive), mode: I(permissions) }); return true; } catch (e) { warn(`mkdir(): ${fsErr('', p, e)}`); return false; } });
def('rmdir', (directory, context = null) => { const p = S(directory); try { fs.rmdirSync(p); return true; } catch (e) { warn(`rmdir(${p}): ${fsErr('', p, e)}`); return false; } });
def('rename', (from, to, context = null) => { try { fs.renameSync(S(from), S(to)); return true; } catch (e) { warn(`rename(${S(from)},${S(to)}): ${fsErr('', '', e)}`); return false; } });
def('copy', (from, to, context = null) => { try { fs.copyFileSync(S(from), S(to)); return true; } catch (e) { warn(`copy(${S(from)}): Failed to open stream: ${fsErr('', '', e)}`); return false; } });
def('tempnam', (directory, prefix) => { const dir = S(directory) || osMod.tmpdir(); const p = pathMod.join(fs.existsSync(dir) ? dir : osMod.tmpdir(), S(prefix).slice(0, 63) + crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, 'x')); fs.writeFileSync(p, ''); return p; });
def('tmpfile', () => { const p = pathMod.join(osMod.tmpdir(), 'php' + crypto.randomBytes(6).toString('hex')); const fd = fs.openSync(p, 'w+'); try { fs.unlinkSync(p); } catch (e) { /* ignore */ } return mkStream('file', fd, p, 'w+'); });
def('sys_get_temp_dir', () => osMod.tmpdir());
def('realpath', (path) => { try { return fs.realpathSync(S(path) || '.'); } catch (e) { return false; } });
def('getcwd', () => process.cwd());
def('chdir', (directory) => { try { process.chdir(S(directory)); return true; } catch (e) { warn(`chdir(): ${fsErr('', '', e)} (errno 2)`); return false; } });
def('chmod', (filename, permissions) => { try { fs.chmodSync(S(filename), I(permissions)); return true; } catch (e) { warn(`chmod(): ${fsErr('', '', e)}`); return false; } });
def('chown', (filename, user) => true); def('chgrp', (filename, group) => true);
def('umask', (mask = null) => (mask === null ? process.umask() : process.umask(I(mask))));
def('symlink', (target, link) => { try { fs.symlinkSync(S(target), S(link)); return true; } catch (e) { warn(`symlink(): ${fsErr('', '', e)}`); return false; } });
def('link', (target, link) => { try { fs.linkSync(S(target), S(link)); return true; } catch (e) { return false; } });
def('readlink', (path) => { try { return fs.readlinkSync(S(path)); } catch (e) { warn(`readlink(): ${fsErr('', '', e)}`); return false; } });
def('disk_free_space', (directory) => { try { const s = fs.statfsSync(S(directory)); return mkf(s.bavail * s.bsize); } catch (e) { return false; } });
def('disk_total_space', (directory) => { try { const s = fs.statfsSync(S(directory)); return mkf(s.blocks * s.bsize); } catch (e) { return false; } });
def('basename', (path, suffix = '') => {
  let p = S(path).replace(/\/+$/, '');
  if (p === '' && S(path).startsWith('/')) return '';
  let b = p.slice(p.lastIndexOf('/') + 1);
  const sf = S(suffix);
  if (sf && b.endsWith(sf) && b !== sf) b = b.slice(0, -sf.length);
  return b;
});
def('dirname', (path, levels = 1) => {
  let p = S(path);
  if (p === '') return '';
  if (I(levels) < 1) throwError('ValueError', 'dirname(): Argument #2 ($levels) must be greater than or equal to 1');
  for (let i = 0; i < I(levels); i++) {
    if (p === '/' ) return '/';
    p = p.replace(/\/+$/, '');
    const idx = p.lastIndexOf('/');
    if (idx < 0) return '.';
    p = idx === 0 ? '/' : p.slice(0, idx).replace(/\/+$/, '') || '/';
  }
  return p;
});
def('pathinfo', (path, flags = 15) => {
  const p = S(path); const out = new PHPArray(); const fl = I(flags);
  const idx = p.lastIndexOf('/');
  const base = p.slice(idx + 1);
  if (fl & 1 && p.includes('/')) out.set('dirname', idx === 0 ? '/' : p.slice(0, idx));
  else if (fl & 1 && base) out.set('dirname', '.');
  if (fl & 2) out.set('basename', base);
  const dot = base.lastIndexOf('.');
  if (fl & 4 && dot >= 0) out.set('extension', base.slice(dot + 1));
  if (fl & 8) out.set('filename', dot >= 0 ? base.slice(0, dot) : base);
  if (fl !== 15) { const v = out.values(); return v.length ? v[0] : ''; }
  return out;
});
def('fnmatch', (pattern, filename, flags = 0) => globToRe(S(pattern), I(flags) & 16).test(S(filename)));
function globToRe(g, ci) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const e = g.indexOf(']', i); if (e < 0) { re += '\\['; continue; } let cls = g.slice(i + 1, e); if (cls[0] === '!') cls = '^' + cls.slice(1); re += '[' + cls.replace(/\\/g, '\\\\') + ']'; i = e; }
    else if (c === '\\' && i + 1 < g.length) { re += '\\' + g[++i]; }
    else re += c.replace(/[.+^${}()|/\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ci ? 'i' : '');
}
function expandBraces(p) {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1].split(',').flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}
def('glob', (pattern, flags = 0) => {
  const fl = I(flags);
  const pats = (fl & 1024) ? expandBraces(S(pattern)) : [S(pattern)];
  const results = [];
  for (const pat of pats) {
    const abs = pat.startsWith('/');
    const parts = pat.split('/').filter((x, i) => x !== '' || i === 0);
    let paths = [abs ? '/' : ''];
    for (let i = abs ? 1 : 0; i < parts.length; i++) {
      const part = parts[i];
      const next = [];
      for (const base of paths) {
        if (!/[*?[]/.test(part)) { const np = base === '' ? part : base === '/' ? '/' + part : base + '/' + part; if (fs.existsSync(np)) next.push(np); continue; }
        const dir = base === '' ? '.' : base;
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch (e) { continue; }
        const re = globToRe(part, false);
        for (const en of entries.sort()) { if (en[0] === '.' && part[0] !== '.') continue; if (re.test(en)) next.push(base === '' ? en : base === '/' ? '/' + en : base + '/' + en); }
      }
      paths = next;
    }
    for (const p of paths) {
      if (fl & 8192) { try { if (!fs.statSync(p).isDirectory()) continue; } catch (e) { continue; } }
      results.push((fl & 2) && statOk(p, (s) => s.isDirectory()) ? p + '/' : p);
    }
  }
  if (!(fl & 4)) results.sort();
  return PHPArray.from(results);
});
def('scandir', (directory, sorting_order = 0, context = null) => {
  try {
    const e = ['.', '..', ...fs.readdirSync(S(directory))];
    e.sort(); if (I(sorting_order) === 1) e.reverse();
    return PHPArray.from(e);
  } catch (err) { warn(`scandir(${S(directory)}): Failed to open directory: ${fsErr('', '', err)}`); warn('scandir(): (errno 2): No such file or directory'); return false; }
});
def('opendir', (directory, context = null) => {
  try { const e = ['.', '..', ...fs.readdirSync(S(directory))]; const r = new PHPResource('stream', new StreamH('dir', -1, S(directory), 'r')); r.h.dirEntries = e; r.h.pos = 0; return r; }
  catch (e) { warn(`opendir(${S(directory)}): Failed to open directory: ${fsErr('', '', e)}`); return false; }
});
def('readdir', (dir_handle = null) => { const h = getStream(dir_handle); if (h.pos >= h.dirEntries.length) return false; return h.dirEntries[h.pos++]; });
def('rewinddir', (dir_handle = null) => { const h = getStream(dir_handle); h.pos = 0; });
def('closedir', (dir_handle = null) => { deref(dir_handle).closed = true; });
def('fileno', (stream) => getStream(stream).fd);
def('escapeshellarg', (arg) => "'" + S(arg).replace(/'/g, "'\\''") + "'");
def('escapeshellcmd', (command) => S(command).replace(/([#&;`|*?~<>^()[\]{}$\\\x0A\xFF"'])/g, '\\$1'));
function runShell(cmd, opts) { rt.flush(); try { return { out: cpMod.execSync(cmd, Object.assign({ stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 1 << 30, shell: '/bin/sh' }, opts || {})), code: 0 }; } catch (e) { return { out: e.stdout || Buffer.alloc(0), code: e.status === null ? 1 : e.status }; } }
def('shell_exec', (command) => { const r = runShell(S(command)); const s = fromBytes(r.out); return s === '' ? null : s; });
def('exec', (command, output = undefined, result_code = undefined) => {
  const r = runShell(S(command)); const s = fromBytes(r.out);
  const lines = s.replace(/\n$/, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  if (s === '') lines.length = 0;
  if (output instanceof Ref) { const a = output.v instanceof PHPArray ? output.v.clone() : new PHPArray(); for (const l of lines) a.push(l); output.v = a; }
  if (result_code instanceof Ref) result_code.v = r.code;
  return lines.length ? lines[lines.length - 1] : '';
}, { refs: [false, true, true] });
def('system', (command, result_code = undefined) => { const r = runShell(S(command)); const s = fromBytes(r.out); rt.echo(s); if (result_code instanceof Ref) result_code.v = r.code; return s.replace(/\n$/, '').split('\n').pop(); }, { refs: [false, true] });
def('passthru', (command, result_code = undefined) => { rt.flush(); let code = 0; try { cpMod.execSync(S(command), { stdio: 'inherit', shell: '/bin/sh' }); } catch (e) { code = e.status || 1; } if (result_code instanceof Ref) result_code.v = code; return null; }, { refs: [false, true] });
def('proc_nice', (priority) => true);
def('popen', (command, mode) => { const r = runShell(S(command)); const st = mkStream('mem', -1, 'popen', 'r'); st.h.mem = fromBytes(r.out); return st; });
def('pclose', (handle) => 0);

// ============================================================================
// Native classes
// ============================================================================
const PHP_VERSION = '8.3.6';
function nativeClass(name, opts = {}) {
  const cls = new PHPClass(name);
  if (opts.parent) inheritFrom(cls, rt.classes.get(opts.parent.toLowerCase()));
  for (const i of opts.interfaces || []) addInterface(cls, rt.classes.get(i.toLowerCase()));
  cls.final = !!opts.final; cls.abstract = !!opts.abstract;
  for (const [mname, fn] of Object.entries(opts.methods || {})) {
    const isStatic = mname.startsWith('static ');
    const n = isStatic ? mname.slice(7) : mname;
    cls.methods.set(n.toLowerCase(), { name: n, cls, vis: 'public', static: isStatic, abstract: false, final: false, fn: { native: fn, isMethod: true, name: n, refs: null, cls } });
  }
  rt.classes.set(cls.lname, cls);
  return cls;
}
function argv0(args, i) { const v = args[i]; return v instanceof Ref ? v.v : (v === undefined ? undefined : v); }

function bootNativeClasses() {
  nativeClass('stdClass');
  closureClass = nativeClass('Closure', {
    final: true,
    methods: {
      __invoke: (self, args) => callFunction(self.fn, args, self.thisObj, self.scope, self.sc, self),
      call: (self, args) => {
        const nt = argv0(args, 0);
        if (!(nt instanceof PHPObject)) throwError('TypeError', `Closure::call(): Argument #1 ($newThis) must be of type object, ${typeOf(nt)} given`);
        return callFunction(self.fn, args.slice(1), nt, nt.cls, nt.cls, self);
      },
      bindTo: (self, args) => closureBind(self, argv0(args, 0), args.length > 1 ? argv0(args, 1) : 'static'),
      'static bind': (self, args) => closureBind(argv0(args, 0), argv0(args, 1), args.length > 2 ? argv0(args, 2) : 'static'),
      'static fromCallable': (self, args) => callableToClosure(argv0(args, 0), rt.frame),
    },
  });
  generatorClass = nativeClass('Generator', {
    final: true, interfaces: ['Iterator'],
    methods: {
      current: (self) => { self.gen.ensure(); return self.gen.done ? null : self.gen.cur; },
      key: (self) => { self.gen.ensure(); return self.gen.done ? null : self.gen.key; },
      next: (self) => { self.gen.next(); return null; },
      valid: (self) => { self.gen.ensure(); return !self.gen.done; },
      rewind: (self) => { const g = self.gen; g.ensure(); if (g.advanced) throwError('Exception', 'Cannot rewind a generator that was already run'); return null; },
      send: (self, args) => self.gen.send(argv0(args, 0) === undefined ? null : argv0(args, 0)),
      throw: (self, args) => self.gen.throwIn(argv0(args, 0)),
      getReturn: (self) => {
        const g = self.gen;
        if (!g.done) throwError('Exception', "Cannot get return value of a generator that hasn't returned");
        return g.ret;
      },
    },
  });
  nativeClass('__PHP_Incomplete_Class');
  nativeClass('WeakReference', {
    final: true,
    methods: {
      'static create': (self, args) => { const o = new PHPObject(rt.classes.get('weakreference')); o.target = argv0(args, 0); return o; },
      get: (self) => self.target || null,
    },
  });
}
function closureBind(cl, newThis, newScope) {
  if (!(cl instanceof PHPObject) || cl.cls !== closureClass) throwError('TypeError', 'Closure::bind(): Argument #1 ($closure) must be of type Closure');
  let scope = cl.scope;
  if (newScope instanceof PHPObject) scope = newScope.cls;
  else if (typeof newScope === 'string' && newScope !== 'static') scope = lookupClass(newScope);
  else if (newScope === null) scope = null;
  if (newThis !== null && newThis !== undefined && !(newThis instanceof PHPObject)) throwError('TypeError', 'Closure::bind(): Argument #2 ($newThis) must be of type ?object');
  if (cl.fn.decl && cl.fn.decl.static && newThis) { warn('Cannot bind an instance to a static closure'); newThis = null; }
  const o = makeClosure(cl.fn, cl.bound, newThis || null, scope, newThis ? newThis.cls : scope);
  return o;
}

// ============================================================================
// PHP-source prelude (exceptions, SPL, DateTime, ...)
// ============================================================================
const PRELUDE = String.raw`<?php
interface Traversable {}
interface Iterator extends Traversable { function current(): mixed; function key(): mixed; function next(): void; function rewind(): void; function valid(): bool; }
interface IteratorAggregate extends Traversable { function getIterator(): Iterator; }
interface ArrayAccess { function offsetExists(mixed $offset): bool; function offsetGet(mixed $offset): mixed; function offsetSet(mixed $offset, mixed $value): void; function offsetUnset(mixed $offset): void; }
interface Countable { function count(): int; }
interface JsonSerializable { function jsonSerialize(): mixed; }
interface Stringable { function __toString(): string; }
interface Serializable { function serialize(); function unserialize(string $data); }
interface UnitEnum {}
interface BackedEnum extends UnitEnum {}
interface Throwable extends Stringable {}
interface OuterIterator extends Iterator { function getInnerIterator(): ?Iterator; }
interface SeekableIterator extends Iterator { function seek(int $offset): void; }
interface SplObserver { function update(SplSubject $subject): void; }
interface SplSubject { function attach(SplObserver $observer): void; function detach(SplObserver $observer): void; function notify(): void; }
interface DateTimeInterface {
  const ATOM = "Y-m-d\\TH:i:sP"; const COOKIE = "l, d-M-Y H:i:s T"; const ISO8601 = "Y-m-d\\TH:i:sO"; const ISO8601_EXPANDED = "X-m-d\\TH:i:sP";
  const RFC822 = "D, d M y H:i:s O"; const RFC850 = "l, d-M-y H:i:s T"; const RFC1036 = "D, d M y H:i:s O"; const RFC1123 = "D, d M Y H:i:s O";
  const RFC7231 = "D, d M Y H:i:s \\G\\M\\T"; const RFC2822 = "D, d M Y H:i:s O"; const RFC3339 = "Y-m-d\\TH:i:sP"; const RFC3339_EXTENDED = "Y-m-d\\TH:i:s.vP"; const RSS = "D, d M Y H:i:s O"; const W3C = "Y-m-d\\TH:i:sP";
}

trait __ThrowableImpl {
  public function __construct($message = "", $code = 0, $previous = null) { $this->message = $message; $this->code = $code; $this->previous = $previous; }
  final public function getMessage(): string { return $this->message; }
  final public function getCode() { return $this->code; }
  final public function getPrevious(): ?Throwable { return $this->previous; }
  final public function getFile(): string { return $this->file; }
  final public function getLine(): int { return $this->line; }
  final public function getTrace(): array { return __exception_trace($this); }
  final public function getTraceAsString(): string { return __exception_trace_string($this); }
  public function __toString(): string {
    $parts = [];
    $e = $this;
    while ($e !== null) {
      $m = $e->getMessage();
      if (($e instanceof TypeError) && (get_class($e) === 'TypeError' || get_class($e) === 'ArgumentCountError') && str_contains($m, ', called in ')) $m .= ' and defined';
      $parts[] = get_class($e) . ($m !== '' ? ': ' . $m : '') . ' in ' . $e->getFile() . ':' . $e->getLine() . "\nStack trace:\n" . $e->getTraceAsString();
      $e = $e->getPrevious();
    }
    return implode("\n\nNext ", array_reverse($parts));
  }
}
class Exception implements Throwable {
  protected $message = ''; protected $code = 0; protected string $file = ''; protected int $line = 0; protected ?Throwable $previous = null;
  use __ThrowableImpl;
}
class Error implements Throwable {
  protected $message = ''; protected $code = 0; protected string $file = ''; protected int $line = 0; protected ?Throwable $previous = null;
  use __ThrowableImpl;
}
class ErrorException extends Exception {
  protected int $severity = E_ERROR;
  public function __construct($message = "", $code = 0, $severity = E_ERROR, $filename = null, $line = null, $previous = null) {
    parent::__construct($message, $code, $previous);
    $this->severity = $severity;
    if ($filename !== null) { $this->file = $filename; $this->line = $line ?? 0; }
    elseif ($line !== null) $this->line = $line;
  }
  final public function getSeverity(): int { return $this->severity; }
}
class TypeError extends Error {}
class ValueError extends Error {}
class ArithmeticError extends Error {}
class DivisionByZeroError extends ArithmeticError {}
class AssertionError extends Error {}
class CompileError extends Error {}
class ParseError extends CompileError {}
class ArgumentCountError extends TypeError {}
class UnhandledMatchError extends Error {}
class LogicException extends Exception {}
class BadFunctionCallException extends LogicException {}
class BadMethodCallException extends BadFunctionCallException {}
class DomainException extends LogicException {}
class InvalidArgumentException extends LogicException {}
class LengthException extends LogicException {}
class OutOfRangeException extends LogicException {}
class RuntimeException extends Exception {}
class OutOfBoundsException extends RuntimeException {}
class OverflowException extends RuntimeException {}
class RangeException extends RuntimeException {}
class UnderflowException extends RuntimeException {}
class UnexpectedValueException extends RuntimeException {}
class JsonException extends Exception {}
class Random\RandomException extends Exception {}

//@lazy
class ArrayIterator implements SeekableIterator, ArrayAccess, Countable, Serializable {
  private $__a; private $__k = []; private $__i = 0;
  public function __construct($array = [], int $flags = 0) { $this->__a = is_object($array) ? get_object_vars($array) : $array; $this->__k = array_keys($this->__a); }
  public function current(): mixed { return $this->valid() ? $this->__a[$this->__k[$this->__i]] : null; }
  public function key(): mixed { return $this->__k[$this->__i] ?? null; }
  public function next(): void { $this->__i++; }
  public function rewind(): void { $this->__k = array_keys($this->__a); $this->__i = 0; }
  public function valid(): bool { return $this->__i < count($this->__k); }
  public function seek(int $offset): void { if ($offset < 0 || $offset >= count($this->__k)) throw new OutOfBoundsException("Seek position $offset is out of range"); $this->__i = $offset; }
  public function count(): int { return count($this->__a); }
  public function offsetExists($key): bool { return isset($this->__a[$key]); }
  public function offsetGet($key): mixed { return $this->__a[$key]; }
  public function offsetSet($key, $value): void { if ($key === null) $this->__a[] = $value; else $this->__a[$key] = $value; }
  public function offsetUnset($key): void { unset($this->__a[$key]); }
  public function getArrayCopy(): array { return $this->__a; }
  public function append($value): void { $this->__a[] = $value; }
  public function asort(int $flags = SORT_REGULAR) { asort($this->__a, $flags); return true; }
  public function ksort(int $flags = SORT_REGULAR) { ksort($this->__a, $flags); return true; }
  public function uasort($callback) { uasort($this->__a, $callback); return true; }
  public function uksort($callback) { uksort($this->__a, $callback); return true; }
  public function getFlags() { return 0; }
  public function setFlags($flags) {}
  public function serialize() { return serialize($this->__a); }
  public function unserialize($data) { $this->__a = unserialize($data); }
  public function __serialize(): array { return $this->__a; }
  public function __unserialize(array $data): void { $this->__a = $data; }
  public function __debugInfo() { return ["\0ArrayIterator\0storage" => $this->__a]; }
}
class RecursiveArrayIterator extends ArrayIterator {
  public function hasChildren(): bool { $c = $this->current(); return is_array($c) || is_object($c); }
  public function getChildren(): ?RecursiveArrayIterator { return new RecursiveArrayIterator($this->current()); }
}
//@lazy
class ArrayObject implements IteratorAggregate, ArrayAccess, Countable, Serializable {
  const STD_PROP_LIST = 1; const ARRAY_AS_PROPS = 2;
  private $__a;
  public function __construct($array = [], int $flags = 0, string $iteratorClass = "ArrayIterator") { $this->__a = is_object($array) ? get_object_vars($array) : $array; }
  public function getIterator(): Iterator { return new ArrayIterator($this->__a); }
  public function count(): int { return count($this->__a); }
  public function offsetExists($key): bool { return isset($this->__a[$key]); }
  public function offsetGet($key): mixed { return $this->__a[$key]; }
  public function offsetSet($key, $value): void { if ($key === null) $this->__a[] = $value; else $this->__a[$key] = $value; }
  public function offsetUnset($key): void { unset($this->__a[$key]); }
  public function getArrayCopy(): array { return $this->__a; }
  public function exchangeArray($array) { $old = $this->__a; $this->__a = $array; return $old; }
  public function append($value): void { $this->__a[] = $value; }
  public function asort(int $flags = SORT_REGULAR) { asort($this->__a, $flags); return true; }
  public function ksort(int $flags = SORT_REGULAR) { ksort($this->__a, $flags); return true; }
  public function uasort($callback) { uasort($this->__a, $callback); return true; }
  public function uksort($callback) { uksort($this->__a, $callback); return true; }
  public function serialize() { return serialize($this->__a); }
  public function unserialize($data) { $this->__a = unserialize($data); }
  public function __serialize(): array { return $this->__a; }
  public function __unserialize(array $data): void { $this->__a = $data; }
  public function __debugInfo() { return ["\0ArrayObject\0storage" => $this->__a]; }
}
//@lazy
class SplDoublyLinkedList implements Iterator, Countable, ArrayAccess, Serializable {
  const IT_MODE_LIFO = 2; const IT_MODE_FIFO = 0; const IT_MODE_DELETE = 1; const IT_MODE_KEEP = 0;
  protected $__d = []; protected $__i = 0; protected $__mode = 0;
  public function push($value) { $this->__d[] = $value; }
  public function pop() { if (!$this->__d) throw new RuntimeException("Can't pop from an empty datastructure"); return array_pop($this->__d); }
  public function shift() { if (!$this->__d) throw new RuntimeException("Can't shift from an empty datastructure"); return array_shift($this->__d); }
  public function unshift($value) { array_unshift($this->__d, $value); }
  public function top() { if (!$this->__d) throw new RuntimeException("Can't peek at an empty datastructure"); return $this->__d[count($this->__d) - 1]; }
  public function bottom() { if (!$this->__d) throw new RuntimeException("Can't peek at an empty datastructure"); return $this->__d[0]; }
  public function isEmpty() { return !$this->__d; }
  public function count(): int { return count($this->__d); }
  public function toArray() { return $this->__d; }
  public function setIteratorMode(int $mode) { $this->__mode = $mode; return 0; }
  public function getIteratorMode() { return $this->__mode; }
  public function offsetExists($index): bool { return $index >= 0 && $index < count($this->__d); }
  public function offsetGet($index): mixed { if ($index < 0 || $index >= count($this->__d)) throw new OutOfRangeException("SplDoublyLinkedList::offsetGet(): Argument #1 (\$index) is out of range"); return $this->__d[$index]; }
  public function offsetSet($index, $value): void { if ($index === null) $this->__d[] = $value; else { if ($index < 0 || $index >= count($this->__d)) throw new OutOfRangeException("SplDoublyLinkedList::offsetSet(): Argument #1 (\$index) is out of range"); $this->__d[$index] = $value; } }
  public function offsetUnset($index): void { if ($index < 0 || $index >= count($this->__d)) throw new OutOfRangeException("SplDoublyLinkedList::offsetUnset(): Argument #1 (\$index) is out of range"); array_splice($this->__d, $index, 1); }
  public function add($index, $value) { array_splice($this->__d, $index, 0, [$value]); }
  public function rewind(): void { $this->__i = ($this->__mode & 2) ? count($this->__d) - 1 : 0; }
  public function valid(): bool { return $this->__i >= 0 && $this->__i < count($this->__d); }
  public function current(): mixed { return $this->__d[$this->__i] ?? null; }
  public function key(): mixed { return $this->__i; }
  public function next(): void {
    if ($this->__mode & 1) { if ($this->__mode & 2) { array_pop($this->__d); $this->__i = count($this->__d) - 1; } else { array_shift($this->__d); } }
    else { $this->__i += ($this->__mode & 2) ? -1 : 1; }
  }
  public function prev(): void { $this->__i += ($this->__mode & 2) ? 1 : -1; }
  public function serialize() { return serialize($this->__d); }
  public function unserialize($data) { $this->__d = unserialize($data); }
  public function __serialize(): array { return [$this->__mode, $this->__d, []]; }
  public function __unserialize(array $data): void { [$this->__mode, $this->__d] = $data; }
  public function __debugInfo() { return ["\0SplDoublyLinkedList\0flags" => $this->__mode, "\0SplDoublyLinkedList\0dllist" => $this->__d]; }
}
class SplQueue extends SplDoublyLinkedList {
  public function enqueue($value) { $this->push($value); }
  public function dequeue() { return $this->shift(); }
}
class SplStack extends SplDoublyLinkedList {
  protected $__mode = 2;
  public function setIteratorMode(int $mode) { $this->__mode = $mode | 2; return 0; }
}
//@lazy
abstract class SplHeap implements Iterator, Countable {
  private $__h = [];
  abstract protected function compare($value1, $value2);
  public function insert($value) { $h = &$this->__h; $h[] = $value; $i = count($h) - 1; while ($i > 0) { $p = ($i - 1) >> 1; if ($this->compare($h[$i], $h[$p]) > 0) { [$h[$i], $h[$p]] = [$h[$p], $h[$i]]; $i = $p; } else break; } return true; }
  public function extract() {
    $h = &$this->__h;
    if (!$h) throw new RuntimeException("Can't extract from an empty heap");
    $top = $h[0]; $last = array_pop($h);
    if ($h) { $h[0] = $last; $n = count($h); $i = 0;
      while (true) { $l = 2 * $i + 1; $r = $l + 1; $m = $i;
        if ($l < $n && $this->compare($h[$l], $h[$m]) > 0) $m = $l;
        if ($r < $n && $this->compare($h[$r], $h[$m]) > 0) $m = $r;
        if ($m === $i) break;
        [$h[$i], $h[$m]] = [$h[$m], $h[$i]]; $i = $m; } }
    return $top;
  }
  public function top() { if (!$this->__h) throw new RuntimeException("Can't peek at an empty heap"); return $this->__h[0]; }
  public function isEmpty() { return !$this->__h; }
  public function count(): int { return count($this->__h); }
  public function rewind(): void {}
  public function valid(): bool { return count($this->__h) > 0; }
  public function current(): mixed { return $this->__h ? $this->__h[0] : null; }
  public function key(): mixed { return count($this->__h) - 1; }
  public function next(): void { if ($this->__h) $this->extract(); }
  public function recoverFromCorruption() { return true; }
  public function isCorrupted() { return false; }
  public function __debugInfo() { return ["\0SplHeap\0flags" => 0, "\0SplHeap\0isCorrupted" => false, "\0SplHeap\0heap" => $this->__h]; }
}
class SplMinHeap extends SplHeap { protected function compare($value1, $value2) { return $value2 <=> $value1; } }
class SplMaxHeap extends SplHeap { protected function compare($value1, $value2) { return $value1 <=> $value2; } }
//@lazy
class SplPriorityQueue implements Iterator, Countable {
  const EXTR_DATA = 1; const EXTR_PRIORITY = 2; const EXTR_BOTH = 3;
  private $__h = []; private $__serial = PHP_INT_MAX; private $__flags = 1;
  public function compare($priority1, $priority2) { return $priority1 <=> $priority2; }
  private function __cmp($a, $b) { $c = $this->compare($a[1], $b[1]); return $c !== 0 ? $c : $a[2] <=> $b[2]; }
  public function insert($value, $priority) { $h = &$this->__h; $h[] = [$value, $priority, $this->__serial--]; $i = count($h) - 1; while ($i > 0) { $p = ($i - 1) >> 1; if ($this->__cmp($h[$i], $h[$p]) > 0) { [$h[$i], $h[$p]] = [$h[$p], $h[$i]]; $i = $p; } else break; } return true; }
  private function __fmt($e) { if ($this->__flags === 3) return ['data' => $e[0], 'priority' => $e[1]]; if ($this->__flags === 2) return $e[1]; return $e[0]; }
  public function extract() {
    $h = &$this->__h;
    if (!$h) throw new RuntimeException("Can't extract from an empty heap");
    $top = $h[0]; $last = array_pop($h);
    if ($h) { $h[0] = $last; $n = count($h); $i = 0;
      while (true) { $l = 2 * $i + 1; $r = $l + 1; $m = $i;
        if ($l < $n && $this->__cmp($h[$l], $h[$m]) > 0) $m = $l;
        if ($r < $n && $this->__cmp($h[$r], $h[$m]) > 0) $m = $r;
        if ($m === $i) break;
        [$h[$i], $h[$m]] = [$h[$m], $h[$i]]; $i = $m; } }
    return $this->__fmt($top);
  }
  public function top() { if (!$this->__h) throw new RuntimeException("Can't peek at an empty heap"); return $this->__fmt($this->__h[0]); }
  public function setExtractFlags(int $flags) { $this->__flags = $flags; return $flags; }
  public function getExtractFlags() { return $this->__flags; }
  public function isEmpty() { return !$this->__h; }
  public function count(): int { return count($this->__h); }
  public function rewind(): void {}
  public function valid(): bool { return count($this->__h) > 0; }
  public function current(): mixed { return $this->__h ? $this->__fmt($this->__h[0]) : null; }
  public function key(): mixed { return count($this->__h) - 1; }
  public function next(): void { if ($this->__h) $this->extract(); }
  public function toArray() { $c = clone $this; $o = []; while ($c->valid()) { $o[] = $c->extract(); } return $o; }
  public function recoverFromCorruption() { return true; }
  public function isCorrupted() { return false; }
}
//@lazy
class SplFixedArray implements IteratorAggregate, ArrayAccess, Countable, JsonSerializable {
  private $__d = []; private $__n = 0;
  public function __construct(int $size = 0) { if ($size < 0) throw new ValueError("SplFixedArray::__construct(): Argument #1 (\$size) must be greater than or equal to 0"); $this->__n = $size; $this->__d = $size ? array_fill(0, $size, null) : []; }
  public static function fromArray($array, bool $preserveKeys = true) { $n = $array ? ($preserveKeys ? max(array_keys($array)) + 1 : count($array)) : 0; $f = new SplFixedArray($n); $i = 0; foreach ($array as $k => $v) { $f[$preserveKeys ? $k : $i++] = $v; } return $f; }
  public function toArray() { return $this->__d; }
  public function getSize() { return $this->__n; }
  public function setSize(int $size) { if ($size < $this->__n) $this->__d = array_slice($this->__d, 0, $size); else for ($i = $this->__n; $i < $size; $i++) $this->__d[$i] = null; $this->__n = $size; return true; }
  public function count(): int { return $this->__n; }
  private function __chk($i) { if (!is_int($i) && !(is_string($i) && is_numeric($i)) && !is_float($i) && !is_bool($i)) throw new TypeError("Cannot access offset of type " . get_debug_type($i) . " on SplFixedArray"); $i = (int)$i; if ($i < 0 || $i >= $this->__n) throw new RuntimeException("Index invalid or out of range"); return $i; }
  public function offsetExists($index): bool { return is_numeric($index) && $index >= 0 && $index < $this->__n && $this->__d[(int)$index] !== null; }
  public function offsetGet($index): mixed { return $this->__d[$this->__chk($index)]; }
  public function offsetSet($index, $value): void { if ($index === null) throw new RuntimeException("[] operator not supported for SplFixedArray"); $this->__d[$this->__chk($index)] = $value; }
  public function offsetUnset($index): void { $this->__d[$this->__chk($index)] = null; }
  public function getIterator(): Iterator { return new ArrayIterator($this->__d); }
  public function jsonSerialize(): array { return $this->__d; }
  public function __wakeup() {}
}
//@lazy
class SplObjectStorage implements Countable, Iterator, ArrayAccess {
  private $__o = []; private $__dt = []; private $__i = 0;
  public function attach(object $object, mixed $info = null): void { $h = spl_object_id($object); $this->__o[$h] = $object; $this->__dt[$h] = $info; }
  public function detach(object $object): void { $h = spl_object_id($object); unset($this->__o[$h], $this->__dt[$h]); }
  public function contains(object $object): bool { return isset($this->__o[spl_object_id($object)]); }
  public function addAll(SplObjectStorage $storage) { foreach ($storage->__o as $h => $o) { $this->__o[$h] = $o; $this->__dt[$h] = $storage->__dt[$h]; } return count($this->__o); }
  public function removeAll(SplObjectStorage $storage) { foreach ($storage->__o as $h => $o) unset($this->__o[$h], $this->__dt[$h]); return count($this->__o); }
  public function removeAllExcept(SplObjectStorage $storage) { foreach ($this->__o as $h => $o) if (!isset($storage->__o[$h])) unset($this->__o[$h], $this->__dt[$h]); return count($this->__o); }
  public function getInfo(): mixed { $k = array_keys($this->__o); return isset($k[$this->__i]) ? $this->__dt[$k[$this->__i]] : null; }
  public function setInfo(mixed $info): void { $k = array_keys($this->__o); if (isset($k[$this->__i])) $this->__dt[$k[$this->__i]] = $info; }
  public function getHash(object $object): string { return spl_object_hash($object); }
  public function count(int $mode = COUNT_NORMAL): int { return count($this->__o); }
  public function rewind(): void { $this->__i = 0; }
  public function valid(): bool { return $this->__i < count($this->__o); }
  public function key(): mixed { return $this->__i; }
  public function current(): mixed { $k = array_keys($this->__o); return isset($k[$this->__i]) ? $this->__o[$k[$this->__i]] : null; }
  public function next(): void { $this->__i++; }
  public function offsetExists($object): bool { return $this->contains($object); }
  public function offsetGet($object): mixed { $h = spl_object_id($object); if (!isset($this->__o[$h])) throw new UnexpectedValueException("Object not found"); return $this->__dt[$h]; }
  public function offsetSet($object, $info = null): void { $this->attach($object, $info); }
  public function offsetUnset($object): void { $this->detach($object); }
  public function __debugInfo() { $s = []; foreach ($this->__o as $h => $o) $s[] = ['obj' => $o, 'inf' => $this->__dt[$h]]; return ["\0SplObjectStorage\0storage" => $s]; }
}
//@lazy
final class WeakMap implements ArrayAccess, Countable, IteratorAggregate {
  private $__o = []; private $__v = [];
  public function offsetExists($object): bool { return isset($this->__o[spl_object_id($object)]); }
  public function offsetGet($object): mixed { $h = spl_object_id($object); if (!isset($this->__o[$h])) throw new Error("Object " . get_class($object) . "#" . $h . " not contained in WeakMap"); return $this->__v[$h]; }
  public function offsetSet($object, $value): void { $h = spl_object_id($object); $this->__o[$h] = $object; $this->__v[$h] = $value; }
  public function offsetUnset($object): void { $h = spl_object_id($object); unset($this->__o[$h], $this->__v[$h]); }
  public function count(): int { return count($this->__o); }
  public function getIterator(): Iterator { $f = function () { foreach ($this->__o as $h => $o) yield $o => $this->__v[$h]; }; return $f(); }
}
//@lazy
class IteratorIterator implements OuterIterator {
  protected $__it;
  public function __construct(Traversable $iterator, ?string $class = null) { $this->__it = $iterator instanceof IteratorAggregate ? $iterator->getIterator() : $iterator; }
  public function getInnerIterator(): ?Iterator { return $this->__it; }
  public function rewind(): void { $this->__it->rewind(); }
  public function valid(): bool { return $this->__it->valid(); }
  public function current(): mixed { return $this->__it->current(); }
  public function key(): mixed { return $this->__it->key(); }
  public function next(): void { $this->__it->next(); }
}
abstract class FilterIterator extends IteratorIterator {
  abstract public function accept(): bool;
  public function rewind(): void { parent::rewind(); $this->__fetch(); }
  public function next(): void { parent::next(); $this->__fetch(); }
  private function __fetch() { while (parent::valid() && !$this->accept()) parent::next(); }
}
class CallbackFilterIterator extends FilterIterator {
  private $__cb;
  public function __construct(Iterator $iterator, callable $callback) { parent::__construct($iterator); $this->__cb = $callback; }
  public function accept(): bool { return (bool)($this->__cb)($this->current(), $this->key(), $this->__it); }
}
class LimitIterator extends IteratorIterator {
  private $__off; private $__lim; private $__pos = 0;
  public function __construct(Iterator $iterator, int $offset = 0, int $limit = -1) { parent::__construct($iterator); $this->__off = $offset; $this->__lim = $limit; }
  public function rewind(): void { parent::rewind(); $this->__pos = 0; for ($i = 0; $i < $this->__off && parent::valid(); $i++) { parent::next(); $this->__pos++; } }
  public function valid(): bool { return ($this->__lim === -1 || $this->__pos < $this->__off + $this->__lim) && parent::valid(); }
  public function next(): void { parent::next(); $this->__pos++; }
  public function getPosition(): int { return $this->__pos; }
}
class InfiniteIterator extends IteratorIterator {
  public function next(): void { parent::next(); if (!parent::valid()) parent::rewind(); }
}
class NoRewindIterator extends IteratorIterator {
  private $__started = false;
  public function rewind(): void { if (!$this->__started) { $this->__started = true; } }
}
class AppendIterator extends IteratorIterator {
  private $__its = []; private $__idx = 0;
  public function __construct() {}
  public function append(Iterator $iterator): void { $this->__its[] = $iterator; if (count($this->__its) === 1) { $this->__idx = 0; $this->__it = $iterator; $iterator->rewind(); } }
  public function rewind(): void { $this->__idx = 0; if ($this->__its) { $this->__it = $this->__its[0]; $this->__it->rewind(); $this->__skip(); } }
  public function valid(): bool { return $this->__it !== null && $this->__idx < count($this->__its) && $this->__it->valid(); }
  public function next(): void { if (!$this->__it) return; $this->__it->next(); $this->__skip(); }
  private function __skip() { while (!$this->__it->valid() && $this->__idx < count($this->__its) - 1) { $this->__idx++; $this->__it = $this->__its[$this->__idx]; $this->__it->rewind(); } }
  public function getIteratorIndex() { return $this->__idx; }
}
//@lazy
class MultipleIterator implements Iterator {
  const MIT_NEED_ANY = 0; const MIT_NEED_ALL = 1; const MIT_KEYS_NUMERIC = 0; const MIT_KEYS_ASSOC = 2;
  private $__its = []; private $__flags;
  public function __construct(int $flags = 1) { $this->__flags = $flags; }
  public function attachIterator(Iterator $iterator, $info = null) { $this->__its[] = [$iterator, $info]; }
  public function countIterators() { return count($this->__its); }
  public function rewind(): void { foreach ($this->__its as [$it]) $it->rewind(); }
  public function valid(): bool { if (!$this->__its) return false; $any = false; $all = true; foreach ($this->__its as [$it]) { if ($it->valid()) $any = true; else $all = false; } return ($this->__flags & 1) ? $all : $any; }
  public function next(): void { foreach ($this->__its as [$it]) $it->next(); }
  public function current(): mixed { $r = []; foreach ($this->__its as $i => [$it, $info]) { $k = ($this->__flags & 2) ? $info : $i; $r[$k] = $it->valid() ? $it->current() : null; } return $r; }
  public function key(): mixed { $r = []; foreach ($this->__its as $i => [$it, $info]) { $k = ($this->__flags & 2) ? $info : $i; $r[$k] = $it->valid() ? $it->key() : null; } return $r; }
}
class EmptyIterator implements Iterator {
  public function current(): never { throw new BadMethodCallException("Accessing the value of an EmptyIterator"); }
  public function key(): never { throw new BadMethodCallException("Accessing the key of an EmptyIterator"); }
  public function next(): void {} public function rewind(): void {} public function valid(): bool { return false; }
}
//@lazy
interface RecursiveIterator extends Iterator { public function hasChildren(): bool; public function getChildren(): ?RecursiveIterator; }
class RecursiveIteratorIterator implements OuterIterator {
  const LEAVES_ONLY = 0; const SELF_FIRST = 1; const CHILD_FIRST = 2; const CATCH_GET_CHILD = 16;
  private $__root; private $__mode; private $__items = []; private $__i = 0; private $__maxDepth = -1;
  public function __construct($iterator, int $mode = self::LEAVES_ONLY, int $flags = 0) { $this->__root = $iterator instanceof IteratorAggregate ? $iterator->getIterator() : $iterator; $this->__mode = $mode; }
  private function __collect($it, $depth) {
    for ($it->rewind(); $it->valid(); $it->next()) {
      $k = $it->key(); $v = $it->current();
      $has = $it->hasChildren() && ($this->__maxDepth < 0 || $depth < $this->__maxDepth);
      if ($has) {
        if ($this->__mode === 1) $this->__items[] = [$k, $v, $depth];
        $this->__collect($it->getChildren(), $depth + 1);
        if ($this->__mode === 2) $this->__items[] = [$k, $v, $depth];
      } else $this->__items[] = [$k, $v, $depth];
    }
  }
  public function rewind(): void { $this->__items = []; $this->__i = 0; $this->__collect($this->__root, 0); }
  public function valid(): bool { return $this->__i < count($this->__items); }
  public function key(): mixed { return $this->__items[$this->__i][0] ?? null; }
  public function current(): mixed { return $this->__items[$this->__i][1] ?? null; }
  public function next(): void { $this->__i++; }
  public function getDepth() { return $this->__items[$this->__i][2] ?? 0; }
  public function setMaxDepth(int $maxDepth = -1): void { $this->__maxDepth = $maxDepth; }
  public function getMaxDepth() { return $this->__maxDepth < 0 ? false : $this->__maxDepth; }
  public function getInnerIterator(): ?Iterator { return $this->__root; }
}
class CachingIterator extends IteratorIterator {
  const CALL_TOSTRING = 1; const FULL_CACHE = 256;
  private $__cur; private $__key; private $__has = false;
  public function rewind(): void { parent::rewind(); $this->__fetch(); }
  private function __fetch() { $this->__has = parent::valid(); if ($this->__has) { $this->__cur = parent::current(); $this->__key = parent::key(); parent::next(); } }
  public function valid(): bool { return $this->__has; }
  public function current(): mixed { return $this->__cur; }
  public function key(): mixed { return $this->__key; }
  public function next(): void { $this->__fetch(); }
  public function hasNext() { return parent::valid(); }
}

//@lazy
class DateTimeZone {
  const UTC = 1024; const ALL = 2047;
  private $__tz;
  public function __construct(string $timezone = "UTC") { if (!__valid_tz($timezone)) throw new Exception("DateTimeZone::__construct(): Unknown or bad timezone ($timezone)"); $this->__tz = $timezone; }
  public function getName(): string { return $this->__tz; }
  public function getOffset(DateTimeInterface $datetime): int { return __tz_info($datetime->getTimestamp(), $this->__tz)['offset']; }
  public static function listIdentifiers(int $timezoneGroup = 2047, ?string $countryCode = null): array { return ['UTC']; }
}
class DateInterval {
  public $y = 0; public $m = 0; public $d = 0; public $h = 0; public $i = 0; public $s = 0; public $f = 0; public $invert = 0; public $days = false;
  public function __construct(string $duration = "PT0S") {
    if (!preg_match('/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/', $duration, $m)) throw new Exception("DateInterval::__construct(): Unknown or bad format ($duration)");
    $this->y = (int)($m[1] ?? 0); $this->m = (int)($m[2] ?? 0); $this->d = (int)($m[4] ?? 0) + 7 * (int)($m[3] ?? 0);
    $this->h = (int)($m[5] ?? 0); $this->i = (int)($m[6] ?? 0); $this->s = (int)($m[7] ?? 0);
  }
  public static function createFromDateString(string $datetime) { $b = 86400 * 365 * 30; $t = strtotime($datetime, $b); $iv = new DateInterval('PT0S'); $diff = $t - $b; $iv->s = $diff; return $iv; }
  public function format(string $format): string {
    $map = ['%y' => $this->y, '%Y' => sprintf('%04d', $this->y), '%m' => $this->m, '%M' => sprintf('%02d', $this->m), '%d' => $this->d, '%D' => sprintf('%02d', $this->d),
      '%h' => $this->h, '%H' => sprintf('%02d', $this->h), '%i' => $this->i, '%I' => sprintf('%02d', $this->i), '%s' => $this->s, '%S' => sprintf('%02d', $this->s),
      '%a' => $this->days === false ? '(unknown)' : $this->days, '%R' => $this->invert ? '-' : '+', '%r' => $this->invert ? '-' : '', '%f' => 0, '%F' => '000000', '%%' => '%'];
    return strtr($format, $map);
  }
}
class DateTime implements DateTimeInterface {
  protected $__ts; protected $__tz; protected $__us = 0;
  public function __construct(string $datetime = "now", ?DateTimeZone $timezone = null) {
    $this->__tz = $timezone ? $timezone->getName() : date_default_timezone_get();
    if (preg_match('/(?:^|\s)(Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i', $datetime, $zm) && !$timezone) { $z = strtoupper($zm[1]); $this->__tz = ($z === 'Z' || $z === 'GMT') ? 'UTC' : (strlen($z) === 5 ? substr($z, 0, 3) . ':' . substr($z, 3) : $z); }
    if (preg_match('/\.(\d{1,6})/', $datetime, $um)) $this->__us = (int)str_pad($um[1], 6, '0');
    elseif ($datetime === 'now') { $this->__us = (int)(fmod(microtime(true), 1) * 1000000); }
    $ts = __strtotime_tz(preg_replace('/\.\d+/', '', $datetime), time(), $this->__tz);
    if ($ts === false) throw new Exception("DateTime::__construct(): Failed to parse time string ($datetime) at position 0 (" . substr($datetime, 0, 1) . "): The timezone could not be found in the database");
    $this->__ts = $ts;
  }
  public function format(string $format): string { return __date_tz($format, $this->__ts, $this->__tz, $this->__us); }
  public function getTimestamp(): int { return $this->__ts; }
  public function getTimezone() { return new DateTimeZone($this->__tz); }
  public function getOffset(): int { return __tz_info($this->__ts, $this->__tz)['offset']; }
  public function getMicrosecond(): int { return $this->__us; }
  protected function __mut() { return $this; }
  public function setTimestamp(int $timestamp) { $c = $this->__mut(); $c->__ts = $timestamp; $c->__us = 0; return $c; }
  public function setTimezone(DateTimeZone $timezone) { $c = $this->__mut(); $c->__tz = $timezone->getName(); return $c; }
  public function setDate(int $year, int $month, int $day) { $c = $this->__mut(); $t = __tz_info($c->__ts, $c->__tz); $c->__ts = __local_to_ts($year, $month, $day, $t['h'], $t['i'], $t['s'], $c->__tz); return $c; }
  public function setTime(int $hour, int $minute, int $second = 0, int $microsecond = 0) { $c = $this->__mut(); $t = __tz_info($c->__ts, $c->__tz); $c->__ts = __local_to_ts($t['y'], $t['m'], $t['d'], $hour, $minute, $second, $c->__tz); $c->__us = $microsecond; return $c; }
  public function setISODate(int $year, int $week, int $dayOfWeek = 1) { $c = $this->__mut(); $jan4 = __local_to_ts($year, 1, 4, 0, 0, 0, $c->__tz); $dow = (int)__date_tz('N', $jan4, $c->__tz); $t = __tz_info($c->__ts, $c->__tz); $base = $jan4 - ($dow - 1) * 86400; $d = __tz_info($base + (($week - 1) * 7 + $dayOfWeek - 1) * 86400, $c->__tz); $c->__ts = __local_to_ts($d['y'], $d['m'], $d['d'], $t['h'], $t['i'], $t['s'], $c->__tz); return $c; }
  public function modify(string $modifier) { $c = $this->__mut(); $ts = __strtotime_tz($modifier, $c->__ts, $c->__tz); if ($ts === false) { trigger_error("DateTime::modify(): Failed to parse time string ($modifier) at position 0 (" . substr($modifier, 0, 1) . ")", E_USER_WARNING); return false; } $c->__ts = $ts; return $c; }
  private function __applyInterval(DateInterval $iv, int $sign) {
    $c = $this->__mut(); $sign = $iv->invert ? -$sign : $sign;
    if ($iv->days !== false && $iv->y === 0 && $iv->m === 0 && false) { $c->__ts += $sign * $iv->days * 86400; return $c; }
    $t = __tz_info($c->__ts, $c->__tz);
    $c->__ts = __local_to_ts($t['y'] + $sign * $iv->y, $t['m'] + $sign * $iv->m, $t['d'] + $sign * $iv->d, $t['h'] + $sign * $iv->h, $t['i'] + $sign * $iv->i, $t['s'] + $sign * $iv->s, $c->__tz);
    return $c;
  }
  public function add(DateInterval $interval) { return $this->__applyInterval($interval, 1); }
  public function sub(DateInterval $interval) { return $this->__applyInterval($interval, -1); }
  public function diff(DateTimeInterface $targetObject, bool $absolute = false): DateInterval {
    $a = $this->getTimestamp(); $b = $targetObject->getTimestamp(); $iv = new DateInterval('PT0S');
    $invert = $b < $a; if ($invert) { [$a, $b] = [$b, $a]; }
    $ta = __tz_info($a, $this->__tz); $tb = __tz_info($b, $this->__tz);
    $y = $tb['y'] - $ta['y']; $m = $tb['m'] - $ta['m']; $d = $tb['d'] - $ta['d']; $h = $tb['h'] - $ta['h']; $i = $tb['i'] - $ta['i']; $s = $tb['s'] - $ta['s'];
    if ($s < 0) { $s += 60; $i--; } if ($i < 0) { $i += 60; $h--; } if ($h < 0) { $h += 24; $d--; }
    if ($d < 0) { $pm = $tb['m'] - 1; $py = $tb['y']; if ($pm < 1) { $pm = 12; $py--; } $d += cal_days_in_month(0, $pm, $py); $m--; }
    if ($m < 0) { $m += 12; $y--; }
    $iv->y = $y; $iv->m = $m; $iv->d = $d; $iv->h = $h; $iv->i = $i; $iv->s = $s; $iv->invert = ($invert && !$absolute) ? 1 : 0;
    $iv->days = intdiv($b - $a - ($tb['offset'] - $ta['offset']) * 0, 86400);
    return $iv;
  }
  public static function createFromFormat(string $format, string $datetime, ?DateTimeZone $timezone = null) {
    $tz = $timezone ? $timezone->getName() : date_default_timezone_get();
    $now = __tz_info(time(), $tz); $y = $now['y']; $mo = $now['m']; $d = $now['d']; $h = $now['h']; $mi = $now['i']; $s = $now['s']; $reset = false; $pos = 0; $timeGiven = false;
    $months = ['jan'=>1,'feb'=>2,'mar'=>3,'apr'=>4,'may'=>5,'jun'=>6,'jul'=>7,'aug'=>8,'sep'=>9,'oct'=>10,'nov'=>11,'dec'=>12]; $pm = null;
    for ($k = 0; $k < strlen($format); $k++) {
      $f = $format[$k]; $rest = substr($datetime, $pos);
      switch ($f) {
        case 'Y': if (!preg_match('/^\d{4}/', $rest, $mm)) return false; $y = (int)$mm[0]; $pos += 4; break;
        case 'y': if (!preg_match('/^\d{2}/', $rest, $mm)) return false; $y = (int)$mm[0]; $y += $y < 70 ? 2000 : 1900; $pos += 2; break;
        case 'm': case 'n': if (!preg_match('/^\d{1,2}/', $rest, $mm)) return false; $mo = (int)$mm[0]; $pos += strlen($mm[0]); break;
        case 'd': case 'j': if (!preg_match('/^\d{1,2}/', $rest, $mm)) return false; $d = (int)$mm[0]; $pos += strlen($mm[0]); break;
        case 'H': case 'G': case 'h': case 'g': if (!preg_match('/^\d{1,2}/', $rest, $mm)) return false; $h = (int)$mm[0]; $pos += strlen($mm[0]); $timeGiven = true; break;
        case 'i': if (!preg_match('/^\d{2}/', $rest, $mm)) return false; $mi = (int)$mm[0]; $pos += 2; $timeGiven = true; break;
        case 's': if (!preg_match('/^\d{2}/', $rest, $mm)) return false; $s = (int)$mm[0]; $pos += 2; $timeGiven = true; break;
        case 'A': case 'a': $pm = strtolower(substr($rest, 0, 2)) === 'pm'; $pos += 2; break;
        case 'M': case 'F': if (!preg_match('/^[a-zA-Z]+/', $rest, $mm)) return false; $mo = $months[strtolower(substr($mm[0], 0, 3))] ?? 1; $pos += strlen($mm[0]); break;
        case 'D': case 'l': if (!preg_match('/^[a-zA-Z]+/', $rest, $mm)) return false; $pos += strlen($mm[0]); break;
        case 'U': if (!preg_match('/^-?\d+/', $rest, $mm)) return false; $o = new static('@' . $mm[0]); return $o;
        case '!': $y = 1970; $mo = 1; $d = 1; $h = 0; $mi = 0; $s = 0; $reset = true; break;
        case '|': $reset = true; break;
        case '\\': $k++; $pos++; break;
        case 'u': case 'v': if (preg_match('/^\d+/', $rest, $mm)) $pos += strlen($mm[0]); break;
        case 'e': case 'T': case 'P': case 'O': if (preg_match('/^[A-Za-z_\/+\-:0-9]+/', $rest, $mm)) $pos += strlen($mm[0]); break;
        default: $pos++;
      }
    }
    if ($pm !== null) { if ($pm && $h < 12) $h += 12; if (!$pm && $h === 12) $h = 0; }
    if ($reset && !$timeGiven) { }
    $o = new static('now', $timezone);
    $o->__ts = __local_to_ts($y, $mo, $d, $h, $mi, $s, $tz); $o->__us = 0;
    return $o;
  }
  public static function createFromInterface(DateTimeInterface $object) { return new static('@' . $object->getTimestamp()); }
  public static function createFromImmutable($object) { $o = new static('@' . $object->getTimestamp()); $o->__tz = $object->getTimezone()->getName(); return $o; }
  public static function getLastErrors() { return false; }
  public function __serialize(): array { return ['date' => $this->format('Y-m-d H:i:s.u'), 'timezone_type' => 3, 'timezone' => $this->__tz]; }
  public function __unserialize(array $data): void { $this->__tz = $data['timezone']; $this->__ts = __strtotime_tz(substr($data['date'], 0, 19), time(), $this->__tz); }
}
class DateTimeImmutable extends DateTime {
  protected function __mut() { return clone $this; }
  public static function createFromMutable($object) { $o = new static('@' . $object->getTimestamp()); return $o->setTimezone($object->getTimezone()); }
}
class DatePeriod implements IteratorAggregate {
  const EXCLUDE_START_DATE = 1; const INCLUDE_END_DATE = 2;
  private $__s; private $__iv; private $__e; private $__opt;
  public function __construct($start, $interval = null, $end = null, $options = 0) { $this->__s = $start; $this->__iv = $interval; $this->__e = $end; $this->__opt = $options; }
  public function getIterator(): Iterator {
    $f = function () {
      $cur = DateTimeImmutable::createFromInterface($this->__s); $i = 0;
      if ($this->__opt & 1) $cur = $cur->add($this->__iv);
      if (is_int($this->__e)) { for ($n = 0; $n <= $this->__e; $n++) { yield $i++ => ($this->__s instanceof DateTimeImmutable ? $cur : DateTime::createFromImmutable($cur)); $cur = $cur->add($this->__iv); } return; }
      while ($cur->getTimestamp() < $this->__e->getTimestamp() || (($this->__opt & 2) && $cur->getTimestamp() == $this->__e->getTimestamp())) { yield $i++ => ($this->__s instanceof DateTimeImmutable ? $cur : DateTime::createFromImmutable($cur)); $cur = $cur->add($this->__iv); }
    };
    return $f();
  }
  public function getStartDate() { return $this->__s; } public function getEndDate() { return $this->__e; } public function getDateInterval() { return $this->__iv; }
}
function date_create($datetime = "now", $timezone = null) { try { return new DateTime($datetime, $timezone); } catch (Exception $e) { return false; } }
function date_create_immutable($datetime = "now", $timezone = null) { try { return new DateTimeImmutable($datetime, $timezone); } catch (Exception $e) { return false; } }
function date_diff($a, $b, $absolute = false) { return $a->diff($b, $absolute); }
function date_add($object, $interval) { return $object->add($interval); }
function date_sub($object, $interval) { return $object->sub($interval); }
function date_format($object, $format) { return $object->format($format); }
function date_modify($object, $modifier) { return $object->modify($modifier); }
function date_timestamp_get($object) { return $object->getTimestamp(); }
function date_interval_format($object, $format) { return $object->format($format); }
`;

function exceptionTrace(obj) { return obj.trace || new PHPArray(); }
def('__exception_trace', (e) => exceptionTrace(e));
def('__exception_trace_string', (e) => traceAsString(exceptionTrace(e)));

// ============================================================================
// Constants
// ============================================================================
function defConsts() {
  const c = (k, v) => rt.consts.set(k, v);
  c('PHP_EOL', '\n'); c('PHP_INT_MAX', I64MAX); c('PHP_INT_MIN', I64MIN); c('PHP_INT_SIZE', 8);
  c('PHP_FLOAT_EPSILON', mkf(Number.EPSILON)); c('PHP_FLOAT_MAX', mkf(Number.MAX_VALUE)); c('PHP_FLOAT_MIN', mkf(2.2250738585072014e-308)); c('PHP_FLOAT_DIG', 15);
  c('NAN', mkf(NaN)); c('INF', mkf(Infinity));
  c('PHP_VERSION', PHP_VERSION); c('PHP_MAJOR_VERSION', 8); c('PHP_MINOR_VERSION', 3); c('PHP_RELEASE_VERSION', 6); c('PHP_VERSION_ID', 80306); c('PHP_EXTRA_VERSION', '');
  c('PHP_OS', process.platform === 'win32' ? 'WINNT' : process.platform === 'darwin' ? 'Darwin' : 'Linux');
  c('PHP_OS_FAMILY', process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Darwin' : 'Linux');
  c('DIRECTORY_SEPARATOR', pathMod.sep); c('PATH_SEPARATOR', pathMod.delimiter); c('PHP_MAXPATHLEN', 4096);
  c('PHP_BINARY', process.execPath); c('PHP_SAPI', 'cli'); c('PHP_DEBUG', 0); c('PHP_ZTS', 0); c('PHP_SHLIB_SUFFIX', 'so'); c('PHP_PREFIX', '/usr'); c('PHP_BINDIR', '/usr/bin'); c('DEFAULT_INCLUDE_PATH', '.:/usr/share/php'); c('PEAR_INSTALL_DIR', '/usr/share/php'); c('PEAR_EXTENSION_DIR', '');
  c('PHP_FD_SETSIZE', 1024); c('PHP_OUTPUT_HANDLER_STDFLAGS', 112);
  const E = { E_ERROR, E_WARNING, E_PARSE, E_NOTICE, E_CORE_ERROR, E_CORE_WARNING, E_COMPILE_ERROR, E_COMPILE_WARNING, E_USER_ERROR, E_USER_WARNING, E_USER_NOTICE, E_STRICT, E_RECOVERABLE_ERROR, E_DEPRECATED, E_USER_DEPRECATED, E_ALL };
  for (const [k, v] of Object.entries(E)) c(k, v);
  const M = { M_PI: Math.PI, M_E: Math.E, M_LOG2E: Math.LOG2E, M_LOG10E: Math.LOG10E, M_LN2: Math.LN2, M_LN10: Math.LN10, M_PI_2: Math.PI / 2, M_PI_4: Math.PI / 4, M_1_PI: 1 / Math.PI, M_2_PI: 2 / Math.PI, M_SQRTPI: 1.77245385090551602729, M_2_SQRTPI: 1.12837916709551257390, M_SQRT2: Math.SQRT2, M_SQRT3: 1.73205080756887729352, M_SQRT1_2: Math.SQRT1_2, M_LNPI: 1.14472988584940017414, M_EULER: 0.57721566490153286061 };
  for (const [k, v] of Object.entries(M)) c(k, mkf(v));
  const ints = {
    PHP_ROUND_HALF_UP: 1, PHP_ROUND_HALF_DOWN: 2, PHP_ROUND_HALF_EVEN: 3, PHP_ROUND_HALF_ODD: 4,
    SORT_REGULAR: 0, SORT_NUMERIC: 1, SORT_STRING: 2, SORT_LOCALE_STRING: 5, SORT_NATURAL: 6, SORT_FLAG_CASE: 8, SORT_ASC: 4, SORT_DESC: 3,
    COUNT_NORMAL: 0, COUNT_RECURSIVE: 1, CASE_LOWER: 0, CASE_UPPER: 1,
    ARRAY_FILTER_USE_BOTH: 1, ARRAY_FILTER_USE_KEY: 2,
    EXTR_OVERWRITE: 0, EXTR_SKIP: 1, EXTR_PREFIX_SAME: 2, EXTR_PREFIX_ALL: 3, EXTR_PREFIX_INVALID: 4, EXTR_IF_EXISTS: 6, EXTR_PREFIX_IF_EXISTS: 5, EXTR_REFS: 256,
    JSON_HEX_TAG: 1, JSON_HEX_AMP: 2, JSON_HEX_APOS: 4, JSON_HEX_QUOT: 8, JSON_FORCE_OBJECT: 16, JSON_NUMERIC_CHECK: 32, JSON_UNESCAPED_SLASHES: 64, JSON_PRETTY_PRINT: 128,
    JSON_UNESCAPED_UNICODE: 256, JSON_PARTIAL_OUTPUT_ON_ERROR: 512, JSON_PRESERVE_ZERO_FRACTION: 1024, JSON_UNESCAPED_LINE_TERMINATORS: 2048, JSON_OBJECT_AS_ARRAY: 1, JSON_BIGINT_AS_STRING: 2,
    JSON_INVALID_UTF8_IGNORE: 1048576, JSON_INVALID_UTF8_SUBSTITUTE: 2097152, JSON_THROW_ON_ERROR: 4194304,
    JSON_ERROR_NONE: 0, JSON_ERROR_DEPTH: 1, JSON_ERROR_STATE_MISMATCH: 2, JSON_ERROR_CTRL_CHAR: 3, JSON_ERROR_SYNTAX: 4, JSON_ERROR_UTF8: 5, JSON_ERROR_RECURSION: 6, JSON_ERROR_INF_OR_NAN: 7, JSON_ERROR_UNSUPPORTED_TYPE: 8, JSON_ERROR_INVALID_PROPERTY_NAME: 9, JSON_ERROR_UTF16: 10,
    PREG_PATTERN_ORDER: 1, PREG_SET_ORDER: 2, PREG_OFFSET_CAPTURE: 256, PREG_UNMATCHED_AS_NULL: 512, PREG_SPLIT_NO_EMPTY: 1, PREG_SPLIT_DELIM_CAPTURE: 2, PREG_SPLIT_OFFSET_CAPTURE: 4, PREG_GREP_INVERT: 1,
    PREG_NO_ERROR: 0, PREG_INTERNAL_ERROR: 1, PREG_BACKTRACK_LIMIT_ERROR: 2, PREG_RECURSION_LIMIT_ERROR: 3, PREG_BAD_UTF8_ERROR: 4, PREG_BAD_UTF8_OFFSET_ERROR: 5, PREG_JIT_STACKLIMIT_ERROR: 6,
    HTML_SPECIALCHARS: 0, HTML_ENTITIES: 1, ENT_HTML401: 0, ENT_COMPAT: 2, ENT_QUOTES: 3, ENT_NOQUOTES: 0, ENT_IGNORE: 4, ENT_SUBSTITUTE: 8, ENT_DISALLOWED: 128, ENT_XML1: 16, ENT_XHTML: 32, ENT_HTML5: 48,
    STR_PAD_LEFT: 0, STR_PAD_RIGHT: 1, STR_PAD_BOTH: 2,
    PATHINFO_DIRNAME: 1, PATHINFO_BASENAME: 2, PATHINFO_EXTENSION: 4, PATHINFO_FILENAME: 8,
    FILE_USE_INCLUDE_PATH: 1, FILE_IGNORE_NEW_LINES: 2, FILE_SKIP_EMPTY_LINES: 4, FILE_APPEND: 8, FILE_NO_DEFAULT_CONTEXT: 16,
    LOCK_SH: 1, LOCK_EX: 2, LOCK_UN: 3, LOCK_NB: 4, SEEK_SET: 0, SEEK_CUR: 1, SEEK_END: 2,
    GLOB_BRACE: 1024, GLOB_MARK: 2, GLOB_NOSORT: 4, GLOB_NOCHECK: 16, GLOB_NOESCAPE: 64, GLOB_ERR: 1, GLOB_ONLYDIR: 8192, GLOB_AVAILABLE_FLAGS: 9303,
    FNM_NOESCAPE: 2, FNM_PATHNAME: 1, FNM_PERIOD: 4, FNM_CASEFOLD: 16,
    SCANDIR_SORT_ASCENDING: 0, SCANDIR_SORT_DESCENDING: 1, SCANDIR_SORT_NONE: 2,
    MB_CASE_UPPER: 0, MB_CASE_LOWER: 1, MB_CASE_TITLE: 2, MB_CASE_FOLD: 3, MB_CASE_UPPER_SIMPLE: 4, MB_CASE_LOWER_SIMPLE: 5, MB_CASE_TITLE_SIMPLE: 6, MB_CASE_FOLD_SIMPLE: 7,
    DEBUG_BACKTRACE_PROVIDE_OBJECT: 1, DEBUG_BACKTRACE_IGNORE_ARGS: 2,
    LC_CTYPE: 0, LC_NUMERIC: 1, LC_TIME: 2, LC_COLLATE: 3, LC_MONETARY: 4, LC_MESSAGES: 5, LC_ALL: 6,
    INI_USER: 1, INI_PERDIR: 2, INI_SYSTEM: 4, INI_ALL: 7,
    CAL_GREGORIAN: 0, PHP_OUTPUT_HANDLER_START: 1, PHP_OUTPUT_HANDLER_WRITE: 0, PHP_OUTPUT_HANDLER_FLUSH: 4, PHP_OUTPUT_HANDLER_CLEAN: 2, PHP_OUTPUT_HANDLER_FINAL: 8, PHP_OUTPUT_HANDLER_CONT: 0, PHP_OUTPUT_HANDLER_END: 8, PHP_OUTPUT_HANDLER_CLEANABLE: 16, PHP_OUTPUT_HANDLER_FLUSHABLE: 32, PHP_OUTPUT_HANDLER_REMOVABLE: 64,
    CRYPT_SALT_LENGTH: 123, CRYPT_BLOWFISH: 1, CONNECTION_NORMAL: 0, CONNECTION_ABORTED: 1, CONNECTION_TIMEOUT: 2,
    UPLOAD_ERR_OK: 0, PHP_QUERY_RFC1738: 1, PHP_QUERY_RFC3986: 2, PHP_URL_SCHEME: 0, PHP_URL_HOST: 1, PHP_URL_PORT: 2, PHP_URL_USER: 3, PHP_URL_PASS: 4, PHP_URL_PATH: 5, PHP_URL_QUERY: 6, PHP_URL_FRAGMENT: 7,
    FILTER_VALIDATE_INT: 257, FILTER_VALIDATE_BOOLEAN: 258, FILTER_VALIDATE_BOOL: 258, FILTER_VALIDATE_FLOAT: 259, FILTER_VALIDATE_REGEXP: 272, FILTER_VALIDATE_DOMAIN: 277, FILTER_VALIDATE_URL: 273, FILTER_VALIDATE_EMAIL: 274, FILTER_VALIDATE_IP: 275, FILTER_DEFAULT: 516, FILTER_UNSAFE_RAW: 516, FILTER_SANITIZE_STRING: 513, FILTER_SANITIZE_NUMBER_INT: 519, FILTER_SANITIZE_NUMBER_FLOAT: 520, FILTER_SANITIZE_SPECIAL_CHARS: 515, FILTER_SANITIZE_FULL_SPECIAL_CHARS: 522, FILTER_SANITIZE_EMAIL: 517, FILTER_SANITIZE_URL: 518, FILTER_SANITIZE_ADD_SLASHES: 523, FILTER_CALLBACK: 1024, FILTER_FLAG_ALLOW_FRACTION: 4096, FILTER_FLAG_ALLOW_THOUSAND: 8192, FILTER_NULL_ON_FAILURE: 134217728, FILTER_FLAG_IPV4: 1048576, FILTER_FLAG_IPV6: 2097152, FILTER_REQUIRE_ARRAY: 16777216, FILTER_FORCE_ARRAY: 67108864,
    PASSWORD_BCRYPT_DEFAULT_COST: 10,
  };
  for (const [k, v] of Object.entries(ints)) c(k, v);
  c('PASSWORD_DEFAULT', '2y'); c('PASSWORD_BCRYPT', '2y');
  c('DATE_ATOM', 'Y-m-d\\TH:i:sP'); c('DATE_COOKIE', 'l, d-M-Y H:i:s T'); c('DATE_ISO8601', 'Y-m-d\\TH:i:sO'); c('DATE_RFC822', 'D, d M y H:i:s O'); c('DATE_RFC850', 'l, d-M-y H:i:s T');
  c('DATE_RFC1036', 'D, d M y H:i:s O'); c('DATE_RFC1123', 'D, d M Y H:i:s O'); c('DATE_RFC7231', 'D, d M Y H:i:s \\G\\M\\T'); c('DATE_RFC2822', 'D, d M Y H:i:s O'); c('DATE_RFC3339', 'Y-m-d\\TH:i:sP');
  c('DATE_RFC3339_EXTENDED', 'Y-m-d\\TH:i:s.vP'); c('DATE_RSS', 'D, d M Y H:i:s O'); c('DATE_W3C', 'Y-m-d\\TH:i:sP');
  STDIN_R = mkStream('stdio', 0, 'php://stdin', 'r');
  STDOUT_R = mkStream('stdio', 1, 'php://stdout', 'w');
  STDERR_R = mkStream('stdio', 2, 'php://stderr', 'w');
  STDIN_R.id = 1; STDOUT_R.id = 2; STDERR_R.id = 3;
  PHPResource.n = 4;
  c('STDIN', STDIN_R); c('STDOUT', STDOUT_R); c('STDERR', STDERR_R);
}

// filter_var (common subset)
def('filter_var', (value, filter = 516, options = 0) => {
  const f = I(filter);
  let flags = 0, opts = null, def_ = undefined;
  if (options instanceof PHPArray) { flags = toInt(options.get('flags') || 0); opts = options.get('options') || null; if (opts instanceof PHPArray && opts.has('default')) def_ = opts.get('default'); }
  else flags = toInt(options);
  const nullOnFail = (flags & 134217728) !== 0;
  const fail = () => (def_ !== undefined ? def_ : nullOnFail ? null : false);
  const s = typeof value === 'string' ? value.trim() : toStr(value);
  switch (f) {
    case 257: {
      let n = null;
      if (/^[+-]?(0|[1-9]\d*)$/.test(s)) n = numericStr(s);
      else if ((flags & 2) && /^0x[0-9a-f]+$/i.test(s)) n = parseInt(s, 16);
      else if ((flags & 1) && /^0[0-7]+$/.test(s)) n = parseInt(s, 8);
      if (n === null || n instanceof Flt) return fail();
      if (opts instanceof PHPArray) { if (opts.has('min_range') && n < toInt(opts.get('min_range'))) return fail(); if (opts.has('max_range') && n > toInt(opts.get('max_range'))) return fail(); }
      return n;
    }
    case 258: { const l = s.toLowerCase(); if (['1', 'true', 'on', 'yes'].includes(l)) return true; if (['0', 'false', 'off', 'no', ''].includes(l)) return value === false || l !== '' || !nullOnFail ? false : null; return nullOnFail ? null : false; }
    case 259: { let t = s; if (flags & 8192) t = t.replace(/,/g, ''); const n = numericStr(t); return n === null ? fail() : mkf(toDbl(n)); }
    case 274: return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(s) ? s : fail();
    case 273: return /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+[^\s]*$/i.test(s) || /^(mailto|news|file):[^\s]+$/i.test(s) ? s : fail();
    case 275: {
      const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);
      const v6 = !v4 && /^[0-9a-f:]+$/i.test(s) && s.includes(':') && (s.match(/::/g) || []).length <= 1;
      if ((flags & 1048576) && !(flags & 2097152)) return v4 ? s : fail();
      if ((flags & 2097152) && !(flags & 1048576)) return v6 ? s : fail();
      return v4 || v6 ? s : fail();
    }
    case 272: { const re = opts instanceof PHPArray ? opts.get('regexp') : null; if (!re) throwError('ValueError', "filter_var(): \"regexp\" option missing"); return callNative(rt.fns.get('preg_match'), [re, s]) ? s : fail(); }
    case 277: return /^[a-z0-9.-]+$/i.test(s) ? s : fail();
    case 519: return toStr(value).replace(/[^0-9+-]/g, '');
    case 520: return toStr(value).replace((flags & 4096) ? /[^0-9+\-.eE]/g : /[^0-9+-]/g, '');
    case 515: case 522: return callNative(rt.fns.get('htmlspecialchars'), [toStr(value), 3]);
    case 517: return toStr(value).replace(/[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~@[\]-]/g, '');
    case 518: return toStr(value).replace(/[^A-Za-z0-9$\-_.+!*'(),{}|\\^~[\]`<>#%";/?:@&=]/g, '');
    case 523: return callNative(rt.fns.get('addslashes'), [toStr(value)]);
    case 513: return toStr(value).replace(/<[^>]*>?/g, '').replace(/["']/g, (c) => (c === '"' ? '&#34;' : '&#39;'));
    case 1024: return opts ? callValue(opts, [value]) : fail();
    default: return value instanceof PHPArray || value instanceof PHPObject ? fail() : toStr(value);
  }
});
def('filter_has_var', () => false);
def('filter_input', () => null);
def('filter_list', () => PHPArray.from(['int', 'boolean', 'float', 'validate_regexp', 'validate_url', 'validate_email', 'validate_ip', 'string', 'unsafe_raw', 'email', 'url', 'number_int', 'number_float', 'callback']));
def('setlocale', (category, ...locales) => 'C');
def('localeconv', () => PHPArray.fromPairs([['decimal_point', '.'], ['thousands_sep', ''], ['int_curr_symbol', ''], ['currency_symbol', ''], ['mon_decimal_point', ''], ['mon_thousands_sep', ''], ['positive_sign', ''], ['negative_sign', '']]));
// ---------------------------------------------------------------- crypt / password_* (bcrypt, md5-crypt, sha-crypt)
let BF_INIT = null;
function bfInit() { // Blowfish P-array and S-boxes are the hex digits of pi; computed once with BigInt Machin
  if (BF_INIT) return BF_INIT;
  const words = 18 + 1024, bits = BigInt(words * 32 + 64);
  const one = 1n << bits;
  const atanInv = (x) => { const X = BigInt(x), X2 = X * X; let term = one / X, sum = term, k = 1n, sign = -1n; while (term > 0n) { term /= X2; sum += sign * (term / (2n * k + 1n)); sign = -sign; k++; } return sum; };
  const pi = 16n * atanInv(5) - 4n * atanInv(239); // pi * 2^bits
  const frac = (pi - 3n * one) >> 64n; // fractional part, words*32 bits
  const out = new Uint32Array(words);
  for (let i = 0; i < words; i++) out[i] = Number((frac >> BigInt((words - 1 - i) * 32)) & 0xffffffffn);
  BF_INIT = out;
  return out;
}
const BCRYPT_B64 = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function bcryptB64Encode(d, len) {
  let off = 0, rs = '';
  while (off < len) {
    let c1 = d[off++];
    rs += BCRYPT_B64[(c1 >> 2) & 0x3f]; c1 = (c1 & 0x03) << 4;
    if (off >= len) { rs += BCRYPT_B64[c1 & 0x3f]; break; }
    let c2 = d[off++]; c1 |= (c2 >> 4) & 0x0f; rs += BCRYPT_B64[c1 & 0x3f]; c1 = (c2 & 0x0f) << 2;
    if (off >= len) { rs += BCRYPT_B64[c1 & 0x3f]; break; }
    c2 = d[off++]; c1 |= (c2 >> 6) & 0x03; rs += BCRYPT_B64[c1 & 0x3f]; rs += BCRYPT_B64[c2 & 0x3f];
  }
  return rs;
}
function bcryptB64Decode(s, maxlen) {
  const out = []; let off = 0;
  const v = (i) => { const c = BCRYPT_B64.indexOf(s[i]); return c; };
  while (off < s.length - 1 && out.length < maxlen) {
    const c1 = v(off++), c2 = v(off++); if (c1 < 0 || c2 < 0) return null;
    out.push(((c1 << 2) | ((c2 & 0x30) >> 4)) & 0xff); if (out.length >= maxlen || off >= s.length) break;
    const c3 = v(off++); if (c3 < 0) return null;
    out.push((((c2 & 0x0f) << 4) | ((c3 & 0x3c) >> 2)) & 0xff); if (out.length >= maxlen || off >= s.length) break;
    const c4 = v(off++); if (c4 < 0) return null;
    out.push((((c3 & 0x03) << 6) | c4) & 0xff);
  }
  return out;
}
function bcryptRaw(pwBytes, saltBytes, cost) {
  const init = bfInit();
  const P = init.slice(0, 18), Sb = init.slice(18);
  const F = (x) => ((((Sb[x >>> 24] + Sb[256 | ((x >>> 16) & 0xff)]) ^ Sb[512 | ((x >>> 8) & 0xff)]) + Sb[768 | (x & 0xff)]) >>> 0);
  const lr = [0, 0];
  const enc = () => {
    let l = lr[0], r = lr[1];
    l ^= P[0];
    for (let i = 1; i <= 16; i += 2) { r ^= F(l) ^ P[i]; l ^= F(r) ^ P[i + 1]; }
    lr[0] = (r ^ P[17]) >>> 0; lr[1] = l >>> 0;
  };
  const stream = (data) => { let off = 0; return () => { let w = 0; for (let i = 0; i < 4; i++) { w = ((w << 8) | data[off]) >>> 0; off = (off + 1) % data.length; } return w; }; };
  const expand = (salt, key) => {
    const ks = stream(key);
    for (let i = 0; i < 18; i++) P[i] = (P[i] ^ ks()) >>> 0;
    lr[0] = 0; lr[1] = 0;
    const ss = salt ? stream(salt) : null;
    for (let i = 0; i < 18; i += 2) { if (ss) { lr[0] ^= ss(); lr[1] ^= ss(); } enc(); P[i] = lr[0]; P[i + 1] = lr[1]; }
    for (let i = 0; i < 1024; i += 2) { if (ss) { lr[0] ^= ss(); lr[1] ^= ss(); } enc(); Sb[i] = lr[0]; Sb[i + 1] = lr[1]; }
  };
  expand(saltBytes, pwBytes);
  const rounds = 2 ** cost;
  for (let i = 0; i < rounds; i++) { expand(null, pwBytes); expand(null, saltBytes); }
  const ctext = [0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274]; // "OrpheanBeholderScryDoubt"
  for (let j = 0; j < 6; j += 2) { lr[0] = ctext[j]; lr[1] = ctext[j + 1]; for (let i = 0; i < 64; i++) enc(); ctext[j] = lr[0]; ctext[j + 1] = lr[1]; }
  const out = [];
  for (const w of ctext) out.push((w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff);
  return out;
}
function bcryptHash(pw, setting) {
  const m = /^\$2([abxy])\$(\d\d)\$([./A-Za-z0-9]{22})/.exec(setting);
  if (!m) return null;
  const cost = parseInt(m[2], 10);
  if (cost < 4 || cost > 31) return null;
  const salt = bcryptB64Decode(m[3], 16);
  if (!salt || salt.length !== 16) return null;
  const key = []; for (let i = 0; i < pw.length && key.length < 72; i++) key.push(pw.charCodeAt(i) & 0xff);
  if (key.length < 72) key.push(0);
  const h = bcryptRaw(key, salt, cost);
  return `$2${m[1]}$${m[2]}$` + bcryptB64Encode(salt, 16) + bcryptB64Encode(h, 23);
}
const CRYPT_B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function to64(v, n) { let s = ''; while (n-- > 0) { s += CRYPT_B64[v & 0x3f]; v >>>= 6; } return s; }
function md5Crypt(pw, setting) {
  const m = /^\$1\$([^$]{0,8})/.exec(setting); const salt = m[1];
  const H = (...parts) => { const h = crypto.createHash('md5'); for (const p of parts) h.update(typeof p === 'string' ? bytes(p) : p); return h.digest(); };
  let fin = H(pw, salt, pw);
  const ctx = [bytes(pw), bytes('$1$'), bytes(salt)];
  for (let pl = pw.length; pl > 0; pl -= 16) ctx.push(fin.subarray(0, Math.min(16, pl)));
  for (let i = pw.length; i; i >>= 1) ctx.push(i & 1 ? Buffer.from([0]) : bytes(pw[0]));
  fin = H(...ctx);
  for (let i = 0; i < 1000; i++) {
    const parts = [];
    parts.push(i & 1 ? bytes(pw) : fin);
    if (i % 3) parts.push(bytes(salt));
    if (i % 7) parts.push(bytes(pw));
    parts.push(i & 1 ? fin : bytes(pw));
    fin = H(...parts);
  }
  const f = fin;
  let out = '$1$' + salt + '$';
  out += to64((f[0] << 16) | (f[6] << 8) | f[12], 4) + to64((f[1] << 16) | (f[7] << 8) | f[13], 4) + to64((f[2] << 16) | (f[8] << 8) | f[14], 4);
  out += to64((f[3] << 16) | (f[9] << 8) | f[15], 4) + to64((f[4] << 16) | (f[10] << 8) | f[5], 4) + to64(f[11], 2);
  return out;
}
function shaCrypt(pw, setting, alg) {
  const isSha512 = alg === '6';
  const m = new RegExp('^\\$' + alg + '\\$(?:rounds=(\\d+)\\$)?([^$]{0,16})').exec(setting);
  if (!m) return null;
  let rounds = m[1] ? Math.min(999999999, Math.max(1000, parseInt(m[1], 10))) : 5000;
  const salt = bytes(m[2]), P0 = bytes(pw);
  const algo = isSha512 ? 'sha512' : 'sha256', hl = isSha512 ? 64 : 32;
  const H = (...parts) => { const h = crypto.createHash(algo); for (const p of parts) h.update(p); return h.digest(); };
  const B = H(P0, salt, P0);
  const aParts = [P0, salt];
  for (let i = P0.length; i > 0; i -= hl) aParts.push(B.subarray(0, Math.min(hl, i)));
  for (let i = P0.length; i > 0; i >>= 1) aParts.push(i & 1 ? B : P0);
  const A = H(...aParts);
  const DP = H(...Array(P0.length).fill(P0));
  const Pseq = Buffer.alloc(P0.length); for (let i = 0; i < P0.length; i++) Pseq[i] = DP[i % hl];
  const DS = H(...Array(16 + A[0]).fill(salt));
  const Sseq = Buffer.alloc(salt.length); for (let i = 0; i < salt.length; i++) Sseq[i] = DS[i % hl];
  let C = A;
  for (let i = 0; i < rounds; i++) {
    const parts = [];
    parts.push(i & 1 ? Pseq : C);
    if (i % 3) parts.push(Sseq);
    if (i % 7) parts.push(Pseq);
    parts.push(i & 1 ? C : Pseq);
    C = H(...parts);
  }
  let out = '$' + alg + '$' + (m[1] ? `rounds=${rounds}$` : '') + m[2] + '$';
  const b = (x, y, z, n) => to64((C[x] << 16) | (C[y] << 8) | C[z], n);
  if (isSha512) {
    const order = [[0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41]];
    for (const [x, y, z] of order) out += b(x, y, z, 4);
    out += to64(C[63], 2);
  } else {
    const order = [[0, 10, 20], [21, 1, 11], [12, 22, 2], [3, 13, 23], [24, 4, 14], [15, 25, 5], [6, 16, 26], [27, 7, 17], [18, 28, 8], [9, 19, 29]];
    for (const [x, y, z] of order) out += b(x, y, z, 4);
    out += to64((C[31] << 8) | C[30], 3);
  }
  return out;
}
function phpCrypt(pw, setting) {
  if (/^\$2[abxy]\$/.test(setting)) return bcryptHash(pw, setting) || (setting[0] === '*' && setting[1] === '0' ? '*1' : '*0');
  if (setting.startsWith('$1$')) return md5Crypt(pw, setting);
  if (setting.startsWith('$5$')) return shaCrypt(pw, setting, '5') || '*0';
  if (setting.startsWith('$6$')) return shaCrypt(pw, setting, '6') || '*0';
  return setting.startsWith('*0') ? '*1' : '*0';
}
function phpSscanf(str, fmt) {
  const out = []; let si = 0, fi = 0, anyConv = false, failed = false;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
  while (fi < fmt.length) {
    const fc = fmt[fi];
    if (isWs(fc)) { while (fi < fmt.length && isWs(fmt[fi])) fi++; while (si < str.length && isWs(str[si])) si++; continue; }
    if (fc !== '%') { if (failed || str[si] !== fc) { failed = true; fi++; continue; } si++; fi++; continue; }
    fi++;
    if (fmt[fi] === '%') { if (str[si] === '%') si++; else failed = true; fi++; continue; }
    let suppress = false; if (fmt[fi] === '*') { suppress = true; fi++; }
    let m = /^\d+/.exec(fmt.slice(fi)); let width = m ? parseInt(m[0], 10) : 0; if (m) fi += m[0].length;
    if ('hlL'.includes(fmt[fi])) fi++;
    let conv = fmt[fi++];
    let set = null;
    if (conv === '[') { let end = fmt.indexOf(']', fmt[fi] === '^' ? fi + 2 : fi + 1); if (end < 0) end = fmt.length; set = fmt.slice(fi, end); fi = end + 1; }
    const push = (v) => { if (!suppress) out.push(v); };
    if (failed || (si >= str.length && conv !== 'n')) { if (!suppress && conv !== 'n') out.push(null); failed = true; continue; }
    if (conv !== 'c' && conv !== '[' && conv !== 'n') while (si < str.length && isWs(str[si])) si++;
    const rest = str.slice(si, width ? si + width : undefined);
    let mm;
    switch (conv) {
      case 'd': case 'i': case 'u':
        mm = (conv === 'i' ? /^[+-]?(0x[0-9a-f]+|0[0-7]*|\d+)/i : /^[+-]?\d+/).exec(rest);
        if (!mm) { failed = true; push(null); break; }
        si += mm[0].length; anyConv = true;
        if (conv === 'i' && /^[+-]?0x/i.test(mm[0])) push(parseInt(mm[0], 16)); else if (conv === 'i' && /^[+-]?0\d/.test(mm[0])) push(parseInt(mm[0], 8)); else { let v = toInt(mm[0]); if (conv === 'u' && v < 0) v = BigInt.asUintN(64, BigInt(v)).toString(); push(v); }
        break;
      case 'x': case 'X': mm = /^[+-]?(0x)?[0-9a-f]+/i.exec(rest); if (!mm) { failed = true; push(null); break; } si += mm[0].length; anyConv = true; push(parseInt(mm[0], 16)); break;
      case 'o': mm = /^[+-]?[0-7]+/.exec(rest); if (!mm) { failed = true; push(null); break; } si += mm[0].length; anyConv = true; push(parseInt(mm[0], 8)); break;
      case 'f': case 'e': case 'E': case 'g':
        mm = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest); if (!mm) { failed = true; push(null); break; } si += mm[0].length; anyConv = true; push(mkf(parseFloat(mm[0]))); break;
      case 's': mm = /^\S+/.exec(rest); if (!mm) { failed = true; push(null); break; } si += mm[0].length; anyConv = true; push(mm[0]); break;
      case 'c': { const n = width || 1; const v = str.substr(si, n); si += v.length; anyConv = true; push(v); break; }
      case '[': {
        const neg = set[0] === '^'; const body = neg ? set.slice(1) : set;
        const re = new RegExp('^[' + (neg ? '^' : '') + body.replace(/\\/g, '\\\\').replace(/]/g, '\\]') + ']+');
        mm = re.exec(rest); if (!mm) { failed = true; push(null); break; } si += mm[0].length; anyConv = true; push(mm[0]); break;
      }
      case 'n': push(si); break;
      default: throwError('ValueError', 'Bad scan conversion character "' + conv + '"');
    }
  }
  return { out, empty: !anyConv && str.length === 0 };
}
def('sscanf', (string, format, ...vars) => {
  const r = phpSscanf(S(string), S(format));
  if (!vars.length) return r.empty ? null : PHPArray.from(r.out);
  if (r.empty) return -1;
  let n = 0;
  vars.forEach((ref, i) => { if (ref instanceof Ref && i < r.out.length) { ref.v = r.out[i]; if (r.out[i] !== null) n++; } });
  return n;
}, { refRest: 2 });
def('fscanf', (stream, format, ...vars) => {
  const line = streamReadLine(getStream(stream), null);
  if (line === false) return false;
  const r = phpSscanf(line, S(format));
  if (!vars.length) return PHPArray.from(r.out);
  let n = 0; vars.forEach((ref, i) => { if (ref instanceof Ref && i < r.out.length) { ref.v = r.out[i]; if (r.out[i] !== null) n++; } });
  return n;
}, { refRest: 2 });
def('crypt', (string, salt) => phpCrypt(S(string), S(salt)));
def('password_hash', (password, algo, options = null) => {
  const a = algo === null ? '2y' : toStr(algo);
  if (a !== '2y' && a !== '1') throwError('ValueError', 'password_hash(): Argument #2 ($algo) must be a valid password hashing algorithm');
  let cost = 10;
  if (options instanceof PHPArray && options.has('cost')) {
    cost = toInt(options.get('cost'));
    if (cost < 4 || cost > 31) throwError('ValueError', `password_hash(): Argument #3 ($options) must contain a "cost" value between 4 and 31`);
  }
  const salt = bcryptB64Encode([...crypto.randomBytes(16)], 16);
  return bcryptHash(S(password), `$2y$${String(cost).padStart(2, '0')}$${salt}`);
});
def('password_verify', (password, hash) => {
  const h = S(hash);
  const r = phpCrypt(S(password), h);
  if (r.length !== h.length) return false;
  return crypto.timingSafeEqual(Buffer.from(r, 'latin1'), Buffer.from(h, 'latin1'));
});
function passwordInfo(h) {
  const m = /^\$2y\$(\d\d)\$[./A-Za-z0-9]{53}$/.exec(h);
  return m ? { algo: '2y', name: 'bcrypt', cost: parseInt(m[1], 10) } : null;
}
def('password_needs_rehash', (hash, algo, options = null) => {
  const info = passwordInfo(S(hash));
  const a = algo === null ? '2y' : toStr(algo);
  if (!info || info.algo !== a) return true;
  const cost = options instanceof PHPArray && options.has('cost') ? toInt(options.get('cost')) : 10;
  return info.cost !== cost;
});
def('password_get_info', (hash) => {
  const info = passwordInfo(S(hash));
  if (!info) return PHPArray.fromPairs([['algo', null], ['algoName', 'unknown'], ['options', new PHPArray()]]);
  return PHPArray.fromPairs([['algo', '2y'], ['algoName', 'bcrypt'], ['options', PHPArray.fromPairs([['cost', info.cost]])]]);
});
def('password_algos', () => PHPArray.from(['2y']));
def('highlight_string', (string, _return = false) => { const s = '<code>' + callNative(rt.fns.get('htmlspecialchars'), [string]) + '</code>'; if (toBool(_return)) return s; rt.echo(s); return true; });
def('php_strip_whitespace', (filename) => { try { return fs.readFileSync(S(filename), 'latin1'); } catch (e) { return ''; } });
def('token_get_all', (code) => { throwError('Error', 'token_get_all() is not supported'); });
def('spl_classes', () => new PHPArray());
def('class_alias', (_class, alias, autoload = true) => { const c = lookupClass(S(_class)); const ln = S(alias).replace(/^\\/, '').toLowerCase(); if (rt.classes.has(ln)) { warn(`Cannot declare class ${S(alias)}, because the name is already in use`); return false; } rt.classes.set(ln, c); return true; });
def('array_key_exists_dummy', () => 0); rt.fns.delete('array_key_exists_dummy');
def('get_resource_type', (resource) => (deref(resource) instanceof PHPResource ? (deref(resource).closed ? 'Unknown' : deref(resource).type) : false));
def('get_resource_id', (resource) => deref(resource).id);
def('get_mangled_object_vars', (object) => { const a = new PHPArray(); for (const [k, v] of object.props) a.set(normKey(k), cp(deref(v))); return a; });
def('get_object_vars_all', (object) => 0); rt.fns.delete('get_object_vars_all');
def('mb_http_output', () => 'UTF-8');
def('lcg', () => 0); rt.fns.delete('lcg');
def('array_flip2', () => 0); rt.fns.delete('array_flip2');
def('str_increment', (string) => { const s = S(string); if (s === '' || !/^[a-zA-Z0-9]+$/.test(s)) throwError('ValueError', 'str_increment(): Argument #1 ($string) must be composed only of alphanumeric ASCII characters'); return strInc(s); });
def('str_decrement', (string) => {
  const s = S(string);
  const ch = s.split(''); let i = ch.length - 1;
  while (i >= 0) { const c = ch[i]; if (c === 'a') { ch[i] = 'z'; i--; } else if (c === 'A') { ch[i] = 'Z'; i--; } else if (c === '0') { ch[i] = '9'; i--; } else { ch[i] = String.fromCharCode(c.charCodeAt(0) - 1); break; } }
  let r = ch.join(''); if (r.length > 1 && (s[0] === 'a' || s[0] === 'A' || s[0] === '1') && i < 0) r = r.slice(1); else if (r.length > 1 && i === 0 && (s[0] === 'a' || s[0] === 'A' || s[0] === '1')) r = r.slice(1);
  return r;
});

// ============================================================================
// Boot & main entry
// ============================================================================
let booted = false, snapshot = null;
const lazyClassSrc = new Map(), lazyFnSrc = new Map(), lazyLoaded = new Set();
function loadLazy(src) {
  if (lazyLoaded.has(src)) return false;
  lazyLoaded.add(src);
  const prevFile = rt.file, prevLine = rt.line, prevFrame = rt.frame;
  try {
    const prog = compileSource(src, 'prelude.php');
    const f = new Frame(null, null, null, null);
    rt.frame = f;
    runProgram(prog, f);
  } finally { rt.file = prevFile; rt.line = prevLine; rt.frame = prevFrame; }
  return true;
}
function lazyClass(ln) { const src = lazyClassSrc.get(ln); if (src && loadLazy(src)) return rt.classes.get(ln) || null; return null; }
function lazyFn(ln) { const src = lazyFnSrc.get(ln); if (src && loadLazy(src)) return rt.fns.get(ln); return undefined; }
function boot() {
  if (booted) return;
  booted = true;
  // interfaces needed by native classes are in the prelude; declare Traversable/Iterator first
  const segs = PRELUDE.split('\n//@lazy\n');
  for (const seg of segs.slice(1)) {
    const src = '<?php\n' + seg;
    for (const m of seg.matchAll(/^(?:abstract |final )*(?:class|interface|trait) (\w+)/gm)) lazyClassSrc.set(m[1].toLowerCase(), src);
    for (const m of seg.matchAll(/^function (\w+)/gm)) lazyFnSrc.set(m[1].toLowerCase(), src);
  }
  const pre = compileSource(segs[0], 'prelude.php');
  // native classes depending on Iterator are created after first prelude statements; split
  const ast = pre.ast;
  const firstIdx = ast.findIndex((s) => s.k === 'ClassDecl' && s.name === '__ThrowableImpl');
  const f = new Frame(null, null, null, null);
  rt.frame = f; rt.file = 'prelude.php';
  defConsts();
  for (let i = 0; i < firstIdx; i++) declareClass(ast[i], f);
  bootNativeClasses();
  hoistDecls(ast.slice(firstIdx), f);
  for (const s of ast.slice(firstIdx)) if (s.k === 'ClassDecl' && !s.declared) declareClass(s, f);
  for (const k of [...rt.fns.keys()]) { const fn = rt.fns.get(k); if (!fn.native) fn.prelude = true; }
  rt.userFnNames.clear();
  snapshot = { fns: new Map(rt.fns), classes: new Map(rt.classes), consts: new Map(rt.consts) };
}
function resetRuntime() {
  rt.fns = new Map(snapshot.fns); rt.classes = new Map(snapshot.classes); rt.consts = new Map(snapshot.consts);
  rt.userFnNames = new Set(); rt.globals = Object.create(null); rt.stack = []; rt.depth = 0; rt.silence = 0;
  rt.errorHandlers = []; rt.exceptionHandlers = []; rt.shutdownFns = []; rt.autoloaders = []; rt.included = new Set();
  rt.obStack = []; rt.outBuf = ''; rt.destructibles = []; rt.inShutdown = false; rt.lastRetRef = null; rt.lastError = null; rt.ini = new Map(); rt.mainStatics = null;
  rt.errorReporting = E_ALL & ~E_DEPRECATED & ~E_STRICT; rt.displayErrors = 'stderr'; rt.precision = 14; rt.serializePrecision = -1;
  jsonLastError = 0; pregLastError = 0;
  PHPResource.n = 4;
  lvVarCache.clear(); lazyLoaded.clear();
}

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
      try { callValue(h, [sig.obj]); return 255; } catch (e2) { return handleTopLevel(e2); }
    }
    rt.flush();
    if (sig.obj.cls.lname === 'parseerror') writeErr(`Parse error: ${toStr(deref(sig.obj.props.get('message')))} in ${deref(sig.obj.props.get('file'))} on line ${deref(sig.obj.props.get('line'))}`);
    else writeErr(`Fatal error: ${formatUncaught(sig.obj)}`);
    return 255;
  }
  throw e;
}

function runScript(code, file, argv, opts = {}) {
  boot();
  resetRuntime();
  if (opts.ini) for (const [k, v] of Object.entries(opts.ini)) { if (!(k in INI_DEFAULTS)) rt.ini.set(k, v); callNative(rt.fns.get('ini_set'), [k, v]); }
  if (opts.capture) rt.capture = [];
  try { rt.ttyOut = !opts.capture && require('tty').isatty(1); } catch (e) { rt.ttyOut = false; }
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
  try {
    gcShutdown();
  } catch (e) { exitCode = handleTopLevel(e); }
  while (rt.obStack.length) { const ob = rt.obStack.pop(); obEmit(obApply(ob, ob.buf, 8)); }
  rt.flush();
  const out = rt.capture ? rt.capture.join('') : null;
  rt.capture = null;
  return { exitCode, output: out };
}

function cliMain(argv) {
  let code = null, file = null, lint = false;
  const ini = {};
  const rest = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (file !== null || code !== null) { rest.push(a); continue; }
    if (a === '-r') { code = '<?php ' + argv[++i]; file = 'Command line code'; continue; }
    if (a === '-l') { lint = true; continue; }
    if (a === '-f') { file = argv[++i]; continue; }
    if (a === '-d') { const kv = argv[++i] || ''; const eq = kv.indexOf('='); ini[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '1' : kv.slice(eq + 1); continue; }
    if (a.startsWith('-d') && a.length > 2) { const kv = a.slice(2); const eq = kv.indexOf('='); ini[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '1' : kv.slice(eq + 1); continue; }
    if (a === '-v' || a === '--version') { process.stdout.write(`PHP ${PHP_VERSION} (cli) (NIP on Node.js ${process.version})\n`); return 0; }
    if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: nip [options] [-f] <file> [--] [args...]\n       nip [options] -r <code> [--] [args...]\n\n  -d foo[=bar]     Define INI entry foo with value \'bar\'\n  -f <file>        Parse and execute <file>.\n  -l               Syntax check only (lint)\n  -r <code>        Run PHP <code> without using script tags <?..?>\n  -v               Version number\n  -h               This help\n');
      return 0;
    }
    if (a === '--') continue;
    file = a;
  }
  let src;
  if (code !== null) src = code;
  else if (file === null || file === '-') {
    try { src = fs.readFileSync(0, 'latin1'); } catch (e) { src = ''; }
    file = 'Standard input code';
  } else {
    try { src = fs.readFileSync(file, 'latin1'); }
    catch (e) { process.stderr.write(`Could not open input file: ${file}\n`); return 1; }
    file = pathMod.resolve(file);
  }
  const scriptArgs = [code !== null ? 'Standard input code' : (file === 'Standard input code' ? '-' : argv[argv.indexOf(rest[0]) - 1] === undefined ? file : file), ...rest];
  if (code === null && file !== 'Standard input code') scriptArgs[0] = argv.find((x) => pathMod.resolve(x) === file) || file;
  if (code !== null) scriptArgs[0] = 'Standard input code';
  if (lint) {
    try { boot(); parsePHP(src, file); process.stdout.write(`No syntax errors detected in ${file}\n`); return 0; }
    catch (e) { if (e instanceof ParseErr) { process.stdout.write(`PHP Parse error:  ${e.msg} in ${file} on line ${e.line}\nErrors parsing ${file}\n`); return 255; } throw e; }
  }
  const r = runScript(src, file, scriptArgs, { ini });
  return r.exitCode;
}

module.exports = {
  run(code, opts = {}) {
    const r = runScript(code, opts.file || 'nip-input', opts.argv || [opts.file || 'nip-input'], { capture: opts.capture !== false, ini: opts.ini });
    return { output: r.output, exitCode: r.exitCode };
  },
  runFile(path, opts = {}) {
    const src = fs.readFileSync(path, 'latin1');
    const r = runScript(src, pathMod.resolve(path), opts.argv || [path], { capture: !!opts.capture, ini: opts.ini });
    return { output: r.output, exitCode: r.exitCode };
  },
  cliMain,
};

if (require.main === module) {
  const { isMainThread, parentPort } = require('worker_threads');
  const argv = process.argv.slice(2);
  let code;
  try { code = cliMain(argv); }
  catch (e) {
    if (e instanceof RangeError) { rt.flush(); writeErr('Fatal error: Maximum call stack size reached. Infinite recursion?'); code = 255; }
    else { rt.flush(); process.stderr.write('PHP Fatal error:  Internal interpreter error: ' + ((e && e.stack) || e) + '\n'); code = 255; }
  }
  if (!isMainThread) parentPort.postMessage({ exit: code });
  else process.exitCode = code;
}
