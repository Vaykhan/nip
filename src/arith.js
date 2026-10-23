// Arithmetic and bitwise operators with PHP int-overflow / float / BigInt semantics.

import {
  bigOrFloat, cp, Flt, fmtRepr, intAdd, intMul, intSub, isInt, MAXS, mkf, normBig, NUM_FULL, NUM_LEAD,
  numericStr, numFromText, PHPArray, PHPObject, Ref
} from './values.js';
import { floatToInt, toDbl, toStr, typeOf } from './convert.js';
import { deprecated, throwError, warn } from './runtime/errors.js';

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

export function add(a, b) {
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
export function sub(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAXS && r >= -MAXS) return r; return intSub(a, b); }
  if (a instanceof Flt && b instanceof Flt) return mkf(a.v - b.v);
  const x = arithOperand(a, '-', a, b), y = arithOperand(b, '-', a, b);
  if (x instanceof Flt || y instanceof Flt) return mkf(toDbl(x) - toDbl(y));
  return intSub(x, y);
}
export function mul(a, b) {
  if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAXS && r >= -MAXS) return r === 0 ? 0 : r; return intMul(a, b); }
  if (a instanceof Flt && b instanceof Flt) return mkf(a.v * b.v);
  const x = arithOperand(a, '*', a, b), y = arithOperand(b, '*', a, b);
  if (x instanceof Flt || y instanceof Flt) return mkf(toDbl(x) * toDbl(y));
  return intMul(x, y);
}
export function div(a, b) {
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
export function mod(a, b) {
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
export function pow(a, b) {
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
export function neg(a) {
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
export function bitAnd(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return bitStr(a, b, 'and');
  const x = bitwiseOperand(a, '&', a, b), y = bitwiseOperand(b, '&', a, b);
  if (typeof x === 'number' && typeof y === 'number' && x >= -2147483648 && x <= 2147483647 && y >= -2147483648 && y <= 2147483647) return x & y;
  return normBig(BigInt.asIntN(64, BigInt(x) & BigInt(y)));
}
export function bitOr(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return bitStr(a, b, 'or');
  const x = bitwiseOperand(a, '|', a, b), y = bitwiseOperand(b, '|', a, b);
  if (typeof x === 'number' && typeof y === 'number' && x >= -2147483648 && x <= 2147483647 && y >= -2147483648 && y <= 2147483647) return x | y;
  return normBig(BigInt.asIntN(64, BigInt(x) | BigInt(y)));
}
export function bitXor(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return bitStr(a, b, 'xor');
  const x = bitwiseOperand(a, '^', a, b), y = bitwiseOperand(b, '^', a, b);
  if (typeof x === 'number' && typeof y === 'number' && x >= -2147483648 && x <= 2147483647 && y >= -2147483648 && y <= 2147483647) return x ^ y;
  return normBig(BigInt.asIntN(64, BigInt(x) ^ BigInt(y)));
}
export function bitNot(a) {
  if (typeof a === 'string') { let r = ''; for (let i = 0; i < a.length; i++) r += String.fromCharCode(~a.charCodeAt(i) & 255); return r; }
  if (a instanceof Flt) { if (!Number.isInteger(a.v) || a.v >= 9223372036854775808 || a.v < -9223372036854775808) deprecated(`Implicit conversion from float ${fmtRepr(a.v)} to int loses precision`); a = floatToInt(a.v); }
  else if (!isInt(a)) throwError('TypeError', `Cannot perform bitwise not on ${typeOf(a)}`);
  if (typeof a === 'number' && a >= -2147483648 && a <= 2147483647) return ~a;
  return normBig(BigInt.asIntN(64, ~BigInt(a)));
}
export function shl(a, b) {
  const x = bitwiseOperand(a, '<<', a, b), y = bitwiseOperand(b, '<<', a, b);
  if (y < 0) throwError('ArithmeticError', 'Bit shift by negative number');
  if (y >= 64) return 0;
  if (typeof x === 'number' && y < 31 && x >= -1048576 && x <= 1048576 && y <= 10) return x << Number(y);
  return normBig(BigInt.asIntN(64, BigInt(x) << BigInt(y)));
}
export function shr(a, b) {
  const x = bitwiseOperand(a, '>>', a, b), y = bitwiseOperand(b, '>>', a, b);
  if (y < 0) throwError('ArithmeticError', 'Bit shift by negative number');
  if (y >= 64) return x < 0 ? -1 : 0;
  if (typeof x === 'number' && x >= -2147483648 && x <= 2147483647) return x >> Number(y);
  return normBig(BigInt(x) >> BigInt(y));
}
export function concat(a, b) {
  return (typeof a === 'string' ? a : toStr(a)) + (typeof b === 'string' ? b : toStr(b));
}

export function strInc(s) {
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
export function inc(v) {
  if (typeof v === 'number') return v < MAXS ? v + 1 : intAdd(v, 1);
  if (v === null || v === undefined) return 1;
  if (v instanceof Flt) return mkf(v.v + 1);
  if (typeof v === 'bigint') return intAdd(v, 1);
  if (typeof v === 'string') return strInc(v);
  if (typeof v === 'boolean') { warn('Increment on type bool has no effect, this will change in the next major version of PHP'); return v; }
  if (v instanceof PHPArray || v instanceof PHPObject) throwError('TypeError', `Cannot increment ${typeOf(v)}`);
  return v;
}
export function dec(v) {
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
