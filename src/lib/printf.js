// printf family: sprintf, printf, vsprintf, number_format, ...

import { fmtFloat, Ref } from '../values.js';
import { toDbl, toInt, toStr } from '../convert.js';
import { rt } from '../runtime/state.js';
import { throwError } from '../runtime/errors.js';
import { A, def, I, N, S } from './core.js';
import { streamWrite } from './file.js';

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

export function phpRound(x, places, mode) {
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
export function numberFormat(x, dec, dp, ts) {
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
