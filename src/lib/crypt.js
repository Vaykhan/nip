// crypt() and password_* (bcrypt, MD5-crypt, SHA-crypt), interoperable with PHP.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { cp, mkf, normKey, PHPArray, PHPResource, Ref } from '../values.js';
import { toBool, toInt, toStr } from '../convert.js';
import { strInc } from '../arith.js';
import { bytes } from '../utf8.js';
import { rt } from '../runtime/state.js';
import { throwError, warn } from '../runtime/errors.js';
import { callNative } from '../runtime/functions.js';
import { lookupClass, objectProps } from '../runtime/classes.js';
import { def, deref, S } from './core.js';
import { getStream, streamReadLine } from './file.js';

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
def('get_mangled_object_vars', (object) => { const a = new PHPArray(); for (const [k, v] of objectProps(object)) a.set(normKey(k), cp(deref(v))); return a; });
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
