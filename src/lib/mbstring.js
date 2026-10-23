// Multibyte string functions (mb_*).

import { isInt, PHPArray } from '../values.js';
import { toBool, toStr } from '../convert.js';
import { isValidUtf8, utf8Decode, utf8Encode } from '../utf8.js';
import { rt } from '../runtime/state.js';
import { throwError } from '../runtime/errors.js';
import { callNative } from '../runtime/functions.js';
import { def, I, S } from './core.js';

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
