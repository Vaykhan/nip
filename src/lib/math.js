// Math functions and random numbers (mt_rand-compatible Mersenne Twister).

import crypto from 'node:crypto';
import { bigOrFloat, Flt, I64MIN, isInt, mkf, normBig, PHPArray } from '../values.js';
import { toDbl, typeOf } from '../convert.js';
import { cmp } from '../compare.js';
import { pow } from '../arith.js';
import { fromBytes } from '../utf8.js';
import { rt } from '../runtime/state.js';
import { throwError } from '../runtime/errors.js';
import { callNative } from '../runtime/functions.js';
import { alias, def, I, IntN, N } from './core.js';
import { phpRound } from './printf.js';

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
export function mtRange(min, max) {
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
