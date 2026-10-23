// Hashing and encoding: md5, sha1, hash*, crc32, base64, bin2hex, uuencode, ...

import crypto from 'node:crypto';
import fs from 'node:fs';
import { normKey, PHPArray, PHPObject, Ref } from '../values.js';
import { toBool, toStr } from '../convert.js';
import { bytes, fromBytes, utf8Decode, utf8Encode } from '../utf8.js';
import { rt } from '../runtime/state.js';
import { throwError, warn } from '../runtime/errors.js';
import { callNative } from '../runtime/functions.js';
import { objVisibleProps } from '../runtime/classes.js';
import { def, I, S } from './core.js';
import { mtRange } from './math.js';

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
