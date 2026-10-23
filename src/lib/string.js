// String functions.

import { Flt, I64MAX, MAXS, mkf, normBig, PHPArray, Ref } from '../values.js';
import { toBool, toInt, toStr, typeOf } from '../convert.js';
import { bytes, fromBytes, isValidUtf8, utf8Decode, utf8Encode } from '../utf8.js';
import { rt } from '../runtime/state.js';
import { deprecated, throwError, warn } from '../runtime/errors.js';
import { callNative } from '../runtime/functions.js';
import { A, alias, def, I, N, S } from './core.js';
import { numberFormat } from './printf.js';

export const lower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
export const upper = (s) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());
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
export const sgn = (x) => (x < 0 ? -1 : x > 0 ? 1 : 0);
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
export function natCmp(a, b, ci) {
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
