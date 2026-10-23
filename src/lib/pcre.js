// PCRE (preg_*): PHP's regex functions on top of NIP's own regex engine (regex.js), following
// ext/pcre/php_pcre.c: pattern delimiters and modifiers, the match loops (including how empty
// matches are retried), result arrays and error codes.

import { PHPArray, Ref } from '../values.js';
import { toStr, typeOf } from '../convert.js';
import { rt } from '../runtime/state.js';
import { throwError, warn } from '../runtime/errors.js';
import { callableFn, isCallable } from '../runtime/callables.js';
import { A, def, I, S } from './core.js';
import { compileRegex, RegexLimitError, RegexSyntaxError } from './regex.js';

const PREG_PATTERN_ORDER = 1, PREG_SET_ORDER = 2, PREG_OFFSET_CAPTURE = 256, PREG_UNMATCHED_AS_NULL = 512;
const PREG_SPLIT_NO_EMPTY = 1, PREG_SPLIT_DELIM_CAPTURE = 2, PREG_SPLIT_OFFSET_CAPTURE = 4;
const E_INTERNAL = 1, E_BACKTRACK = 2, E_RECURSION = 3, E_BAD_UTF8 = 4, E_BAD_UTF8_OFFSET = 5, E_JIT_STACK = 6;

let pregLastError = 0;
export function resetPcreState() { pregLastError = 0; }
const PREG_ERR_MSG = { 0: 'No error', 1: 'Internal error', 2: 'Backtrack limit exhausted', 3: 'Recursion limit exhausted', 4: 'Malformed UTF-8 characters, possibly incorrectly encoded', 5: 'The offset did not correspond to the beginning of a valid UTF-8 code point', 6: 'JIT stack limit exhausted' };

// ------------------------------------------------------------------ compiling
const reCache = new Map();
function pregCompile(pattern) {
  let c = reCache.get(pattern);
  if (c !== undefined) return c;
  c = pregCompile0(pattern);
  if (c === null) { pregLastError = E_INTERNAL; return null; } // not cached: the warning repeats, as in PHP
  if (reCache.size > 4096) reCache.clear();
  reCache.set(pattern, c);
  return c;
}
const BRACKETS = { '(': ')', '[': ']', '{': '}', '<': '>' };
function pregCompile0(pat) {
  const fn = rt.nativeName || 'preg_match';
  let i = 0;
  while (i < pat.length && /[ \t\n\r\v\f]/.test(pat[i])) i++;
  if (i >= pat.length) { warn(`${fn}(): Empty regular expression`); return null; }
  const d = pat[i];
  if (/[a-zA-Z0-9\\]/.test(d) || d === '\0') { warn(`${fn}(): Delimiter must not be alphanumeric, backslash, or NUL`); return null; }
  const close = BRACKETS[d] || d;
  let j = -1;
  if (close === d) {
    for (let k = i + 1; k < pat.length; k++) { if (pat[k] === '\\' && k + 1 < pat.length) { k++; continue; } if (pat[k] === d) { j = k; break; } }
  } else {
    let depth = 1;
    for (let k = i + 1; k < pat.length; k++) {
      if (pat[k] === '\\' && k + 1 < pat.length) { k++; continue; }
      if (pat[k] === close && --depth <= 0) { j = k; break; }
      if (pat[k] === d) depth++;
    }
  }
  if (j < 0) { warn(close === d ? `${fn}(): No ending delimiter '${d}' found` : `${fn}(): No ending matching delimiter '${close}' found`); return null; }
  const body = pat.slice(i + 1, j);
  const o = { caseless: false, multiline: false, dotall: false, extended: false, anchored: false, dollarEndOnly: false, ungreedy: false, utf: false, ucp: false, dupnames: false, noAutoCapture: false };
  let evalMod = false;
  for (const m of pat.slice(j + 1)) {
    switch (m) {
      case 'i': o.caseless = true; break;
      case 'm': o.multiline = true; break;
      case 'n': o.noAutoCapture = true; break;
      case 's': o.dotall = true; break;
      case 'x': o.extended = true; break;
      case 'A': o.anchored = true; break;
      case 'D': o.dollarEndOnly = true; break;
      case 'S': case 'X': case ' ': case '\n': case '\r': break;
      case 'U': o.ungreedy = true; break;
      case 'u': o.utf = true; o.ucp = true; break;
      case 'J': o.dupnames = true; break;
      case 'e': evalMod = true; break;
      default:
        warn(m === '\0' ? `${fn}(): NUL is not a valid modifier` : `${fn}(): Unknown modifier '${m}'`);
        return null;
    }
  }
  if (evalMod) { warn(`${fn}(): The /e modifier is no longer supported, use preg_replace_callback instead`); return null; }
  // (*UTF) at the start of the pattern switches UTF mode on, like the u modifier (without UCP)
  if (/^(\(\*[A-Z_]+(=\d+)?\))*\(\*UTF8?\)/.test(body)) o.utf = true;
  let cps, offs;
  if (o.utf) {
    const dec = decodeUtf8(body);
    if (dec.error) { warn(`${fn}(): Compilation failed: UTF-8 error: ${dec.error} at offset ${dec.at}`); return null; }
    cps = dec.units; offs = dec.offs;
  } else {
    cps = new Array(body.length); offs = new Array(body.length + 1);
    for (let k = 0; k < body.length; k++) { cps[k] = body.charCodeAt(k); offs[k] = k; }
    offs[body.length] = body.length;
  }
  let re;
  try { re = compileRegex(cps, offs, o); }
  catch (e) {
    if (e instanceof RegexSyntaxError) { warn(`${fn}(): Compilation failed: ${e.msg} at offset ${e.offset}`); return null; }
    throw e;
  }
  // group number -> name (the last name given to a number wins, as in php_pcre.c)
  const names = new Array(re.ncap + 1).fill(null);
  for (const { name, num } of re.names) names[num] = name;
  return { re, utf: o.utf, ncap: re.ncap, names, hasNames: re.names.length > 0 };
}

// ------------------------------------------------------------------ subjects
// UTF-8 decoding with PCRE2's error messages; units are code points, offs their byte offsets.
// Lenient decoding (for subjects) turns each invalid byte into a unit no character matches,
// and lists their offsets in `bad`.
function utf8Error(s, i) {
  const b = s.charCodeAt(i);
  let need, cp;
  if (b >= 0x80 && b < 0xc0) return ['isolated byte with 0x80 bit set'];
  if (b >= 0xf8) return [b < 0xfc ? '5-byte character is not allowed (RFC 3629)' : b < 0xfe ? '6-byte character is not allowed (RFC 3629)' : 'illegal byte (0xfe or 0xff)'];
  if (b >= 0xf0) { need = 3; cp = b & 0x07; } else if (b >= 0xe0) { need = 2; cp = b & 0x0f; } else { need = 1; cp = b & 0x1f; }
  if (i + need >= s.length) return [`${need} byte${need > 1 ? 's' : ''} missing at end`];
  for (let k = 1; k <= need; k++) {
    const c = s.charCodeAt(i + k);
    if ((c & 0xc0) !== 0x80) return [`byte ${k + 1} top bits not 0x80`];
    cp = (cp << 6) | (c & 0x3f);
  }
  if ((need === 1 && cp < 0x80) || (need === 2 && cp < 0x800) || (need === 3 && cp < 0x10000)) return [`overlong ${need + 1}-byte sequence`];
  if (cp > 0x10ffff) return ['code points greater than 0x10ffff are not defined'];
  if (cp >= 0xd800 && cp <= 0xdfff) return ['code points 0xd800-0xdfff are not defined'];
  return [null, cp, need + 1];
}
function decodeUtf8(s, lenient) {
  const units = [], offs = [], bad = [];
  for (let i = 0; i < s.length;) {
    const b = s.charCodeAt(i);
    offs.push(i);
    if (b < 0x80) { units.push(b); i++; continue; }
    const [error, cp, len] = utf8Error(s, i);
    if (error) {
      if (!lenient) return { error, at: i };
      units.push(0x110000 + b); bad.push(i); i++;
      continue;
    }
    units.push(cp);
    i += len;
  }
  offs.push(s.length);
  return { units, offs, bad };
}
// a byte string subject: the code units are only built when the regex engine runs (not the JS
// RegExp fast path)
class ByteSubject {
  constructor(s) { this.s = s; this.u = null; this.utf = false; this.checked = true; }
  get units() {
    if (this.u === null) { const s = this.s, u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); this.u = u; }
    return this.u;
  }
}
// A subject prepared for matching: code units, and for UTF the byte offset of each unit and
// the unit index of each byte offset (-1 inside a character). The last one is reused.
let lastSubj = null, lastPrep = null, lastUtf = false;
function prepare(c, s) {
  if (s === lastSubj && c.utf === lastUtf) return lastPrep;
  let prep;
  if (!c.utf) {
    prep = new ByteSubject(s);
  } else {
    const dec = decodeUtf8(s, true);
    const idx = new Int32Array(s.length + 1).fill(-1);
    dec.offs.forEach((b, k) => { idx[b] = k; });
    prep = { units: Int32Array.from(dec.units), s, utf: true, offs: dec.offs, idx, lastBad: dec.bad.length ? dec.bad[dec.bad.length - 1] : -1 };
  }
  lastSubj = s; lastPrep = prep; lastUtf = c.utf;
  return prep;
}
const toByte = (prep, u) => (prep.utf ? prep.offs[u] : u);
const execOpts = {};
let callLimits = null; // limits() for the running preg_* call
// the pcre.* ini settings, read again when they change
let limB, limR, limJ, limitsVal = null;
function limits() {
  const b = rt.ini.get('pcre.backtrack_limit'), r = rt.ini.get('pcre.recursion_limit'), j = rt.ini.get('pcre.jit');
  if (limitsVal === null || b !== limB || r !== limR || j !== limJ) {
    limB = b; limR = r; limJ = j;
    const backtrack = Math.max(1, parseInt(b || '1000000', 10) || 1000000), recursion = Math.max(1, parseInt(r || '100000', 10) || 100000);
    const jit = /^(1|on|true|yes)$/i.test(String(j ?? '1'));
    // the JS RegExp fast path can't enforce lower limits
    limitsVal = { backtrack, recursion, jit, fast: backtrack >= 1000000 && (jit || recursion >= 100000) };
  }
  return limitsVal;
}
// one match attempt from byte offset `off`: { count, ov (byte offsets, -1 unset), mark }, null
// for no match, or false after an error (pregLastError is set)
function matchAt(c, prep, off, opts) {
  let start = off;
  if (prep.utf) {
    if (prep.lastBad >= 0 && prep.lastBad >= off - 1) { pregLastError = E_BAD_UTF8; return false; }
    start = prep.idx[off];
    if (start < 0) { pregLastError = E_BAD_UTF8_OFFSET; return false; }
  }
  let r;
  const lim = callLimits || (callLimits = limits());
  execOpts.backtrackLimit = lim.backtrack; execOpts.recursionLimit = lim.recursion;
  execOpts.notEmptyAtStart = !!(opts && opts.notEmptyAtStart); execOpts.anchored = !!(opts && opts.anchored);
  // php_pcre.c uses the JIT except for the anchored retry after an empty match, and for the
  // first match in UTF mode (which checks the subject)
  execOpts.jit = lim.jit && !execOpts.anchored && !(prep.utf && !prep.checked);
  try {
    r = prep.utf ? c.re.exec(prep.units, start, execOpts) : c.re.execStr(prep.s, () => prep.units, start, execOpts, lim.fast);
  } catch (e) {
    if (e instanceof RegexLimitError) { pregLastError = e.kind === 'recursion' ? E_RECURSION : e.kind === 'jit' ? E_JIT_STACK : E_BACKTRACK; return false; }
    if (e instanceof RangeError) { pregLastError = E_JIT_STACK; return false; }
    throw e;
  }
  prep.checked = true;
  if (!r) return null;
  const ov = new Array(r.caps.length);
  let count = 1;
  for (let g = 0; g < r.caps.length; g += 2) {
    if (r.caps[g + 1] >= 0 && r.caps[g] >= 0) { ov[g] = toByte(prep, r.caps[g]); ov[g + 1] = toByte(prep, r.caps[g + 1]); count = g / 2 + 1; }
    else { ov[g] = -1; ov[g + 1] = -1; }
  }
  return { count, ov, mark: r.mark };
}
const checkSubject = (c, s) => prepare(c, s);
// the length of the character at byte offset `off` (to step over it after an empty match)
const unitLen = (prep, off) => {
  if (!prep.utf) return 1;
  const u = prep.idx[off];
  return prep.offs[u + 1] - off;
};

// ------------------------------------------------------------------ result arrays
function matchValue(s, st, en, asNull) { return st < 0 ? (asNull ? null : '') : s.slice(st, en); }
function offsetPair(s, st, en, asNull) { return PHPArray.from([st < 0 ? (asNull ? null : '') : s.slice(st, en), st]); }
// populate_subpat_array: groups up to the last one that matched (all with UNMATCHED_AS_NULL)
function subpatArray(c, s, m, flags) {
  const offCap = (flags & PREG_OFFSET_CAPTURE) !== 0, asNull = (flags & PREG_UNMATCHED_AS_NULL) !== 0;
  const out = new PHPArray();
  const n = asNull ? c.ncap + 1 : m.count;
  for (let g = 0; g < n; g++) {
    const st = g < m.count ? m.ov[2 * g] : -1, en = g < m.count ? m.ov[2 * g + 1] : -1;
    const v = offCap ? offsetPair(s, st, en, asNull) : matchValue(s, st, en, asNull);
    if (c.names[g] !== null && (st >= 0 || !out.has(c.names[g]))) out.set(c.names[g], offCap ? v.clone() : v);
    out.push(v);
  }
  if (m.mark !== null && m.mark !== undefined) out.set('MARK', m.mark);
  return out;
}
const negOffset = (off, len) => (off < 0 ? (-off <= len ? len + off : 0) : off);

// ------------------------------------------------------------------ preg_match / preg_match_all
function matchImpl(name, pattern, subject, matches, flags, offset, global) {
  callLimits = null;
  const c = pregCompile(S(pattern));
  if (!c) return false;
  pregLastError = 0;
  const s = S(subject);
  let fl = I(flags), order = 0;
  if (fl & 0xff) order = fl & 0xff;
  if ((global && (order < PREG_PATTERN_ORDER || order > PREG_SET_ORDER) && order !== 0) || (!global && order !== 0)) {
    throwError('ValueError', `${name}(): Argument #4 ($flags) must be a PREG_* constant`);
  }
  if (global && order === 0) order = PREG_PATTERN_ORDER;
  const offCap = (fl & PREG_OFFSET_CAPTURE) !== 0, asNull = (fl & PREG_UNMATCHED_AS_NULL) !== 0;
  if (matches instanceof Ref) matches.v = new PHPArray();
  let off = negOffset(I(offset), s.length);
  if (off > s.length) { pregLastError = E_INTERNAL; return false; }
  const prep = checkSubject(c, s);
  if (!prep) return false;
  const sets = global && order === PREG_PATTERN_ORDER ? Array.from({ length: c.ncap + 1 }, () => new PHPArray()) : null;
  const setList = global && order === PREG_SET_ORDER ? new PHPArray() : null;
  let marks = null, matched = 0, opts = null;
  for (;;) {
    const m = matchAt(c, prep, off, opts);
    if (m === false) return false;
    if (m === null) {
      if (opts) {
        // no non-empty match at the position of an empty one: step over a character
        opts = null;
        if (off < s.length) { off += unitLen(prep, off); continue; }
      }
      break;
    }
    if (m.ov[1] < m.ov[0]) { warn(`${name}(): Get subpatterns list failed`); if (matches instanceof Ref) matches.v = new PHPArray(); return false; }
    matched++;
    if (!global) { if (matches instanceof Ref) matches.v = subpatArray(c, s, m, fl); break; }
    if (sets) {
      for (let g = 0; g <= c.ncap; g++) {
        const st = g < m.count ? m.ov[2 * g] : -1, en = g < m.count ? m.ov[2 * g + 1] : -1;
        sets[g].push(offCap ? offsetPair(s, st, en, asNull) : matchValue(s, st, en, asNull));
      }
      if (m.mark !== null && m.mark !== undefined) { if (!marks) marks = new PHPArray(); marks.set(matched - 1, m.mark); }
    } else setList.push(subpatArray(c, s, m, fl));
    off = m.ov[1];
    // after an empty match, look for a non-empty one at the same place first
    opts = m.ov[1] === m.ov[0] ? { notEmptyAtStart: true, anchored: true } : null;
    if (off > s.length) break;
  }
  if (global && matches instanceof Ref) {
    if (sets) {
      const out = new PHPArray();
      for (let g = 0; g <= c.ncap; g++) {
        if (c.names[g] !== null) out.set(c.names[g], sets[g].clone());
        out.push(sets[g]);
      }
      if (marks) out.set('MARK', marks);
      matches.v = out;
    } else matches.v = setList;
  }
  return matched;
}
def('preg_match', (pattern, subject, matches = undefined, flags = 0, offset = 0) => matchImpl('preg_match', pattern, subject, matches, flags, offset, false), { refs: [false, false, true] });
def('preg_match_all', (pattern, subject, matches = undefined, flags = 0, offset = 0) => matchImpl('preg_match_all', pattern, subject, matches, flags, offset, true), { refs: [false, false, true] });

// ------------------------------------------------------------------ preg_replace and friends
// a replacement string with \n, $n and ${n} references (n up to 99); \\ is a backslash
function parseReplacement(rep) {
  const parts = [];
  let lit = '';
  for (let i = 0; i < rep.length;) {
    const ch = rep[i];
    if ((ch === '\\' || ch === '$') && i + 1 < rep.length) {
      if (ch === '\\' && rep[i + 1] === '\\') { lit += '\\'; i += 2; continue; }
      let j = i + 1, brace = false;
      if (ch === '$' && rep[j] === '{') { brace = true; j++; }
      if (rep[j] >= '0' && rep[j] <= '9') {
        let n = rep.charCodeAt(j++) - 48;
        if (rep[j] >= '0' && rep[j] <= '9') n = n * 10 + rep.charCodeAt(j++) - 48;
        if (!brace || rep[j] === '}') {
          if (brace) j++;
          if (lit) { parts.push(lit); lit = ''; }
          parts.push(n);
          i = j;
          continue;
        }
      }
    }
    lit += ch; i++;
  }
  if (lit) parts.push(lit);
  return parts;
}
function expand(parts, s, m) {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') out += p;
    else if (p < m.count && m.ov[2 * p] >= 0) out += s.slice(m.ov[2 * p], m.ov[2 * p + 1]);
  }
  return out;
}
// replace in one subject string: null after an error
function replaceOne(c, s, repFn, limit, counter) {
  const prep = checkSubject(c, s);
  if (!prep) return null;
  let out = '', lastEnd = 0, off = 0, opts = null;
  for (;;) {
    if (limit === 0) break;
    const m = matchAt(c, prep, off, opts);
    if (m === false) return null;
    if (m === null) {
      if (opts) { opts = null; if (off < s.length) { off += unitLen(prep, off); continue; } }
      break;
    }
    if (m.ov[1] < m.ov[0]) { pregLastError = E_INTERNAL; return null; }
    out += s.slice(lastEnd, m.ov[0]) + repFn(m);
    counter.n++;
    if (limit > 0) limit--;
    lastEnd = off = m.ov[1];
    opts = m.ov[1] === m.ov[0] ? { notEmptyAtStart: true, anchored: true } : null;
  }
  return out + s.slice(lastEnd);
}
function arrayOrString(name, n, pname, v) {
  if (v instanceof PHPArray || typeof v === 'string' || v === null || typeof v !== 'object' || (v.cls && v.cls.methods.has('__tostring'))) return;
  throwError('TypeError', `${name}(): Argument #${n} ($${pname}) must be of type array|string, ${typeOf(v)} given`);
}
function replaceImpl(name, pattern, replacement, subject, limit, count, isCb, flags) {
  callLimits = null;
  arrayOrString(name, 1, 'pattern', pattern);
  if (!isCb) arrayOrString(name, 2, 'replacement', replacement);
  arrayOrString(name, 3, 'subject', subject);
  pregLastError = 0;
  const lim = limit === null ? -1 : I(limit);
  const counter = { n: 0 };
  let pats, reps = null;
  if (pattern instanceof PHPArray) pats = pattern.values().map(toStr);
  else pats = [S(pattern)];
  if (!isCb) {
    if (replacement instanceof PHPArray) {
      if (!(pattern instanceof PHPArray)) throwError('TypeError', `${name}(): Argument #1 ($pattern) must be of type array when argument #2 ($replacement) is an array, string given`);
      reps = replacement.values().map((v) => parseReplacement(toStr(v)));
    }
  }
  const single = !isCb && !reps ? parseReplacement(toStr(replacement)) : null;
  const cb = isCb ? callableFn(replacement) : null;
  const doOne = (s) => {
    s = toStr(s);
    for (let i = 0; i < pats.length; i++) {
      const c = pregCompile(pats[i]);
      if (!c) return null;
      let fn;
      if (isCb) fn = (m) => toStr(cb(subpatArray(c, s, m, flags || 0)));
      else { const parts = reps ? (i < reps.length ? reps[i] : []) : single; fn = (m) => expand(parts, s, m); }
      const r = replaceOne(c, s, fn, lim, counter);
      if (r === null) return null;
      s = r;
    }
    return s;
  };
  let r;
  if (subject instanceof PHPArray) {
    r = new PHPArray();
    for (const [k, v] of subject.entries()) {
      const before = counter.n;
      const x = doOne(v);
      if (x !== null && (name !== 'preg_filter' || counter.n > before)) r.set(k, x);
    }
  } else {
    r = doOne(subject);
    if (name === 'preg_filter' && counter.n === 0) r = null;
  }
  if (count instanceof Ref) count.v = counter.n;
  return r;
}
def('preg_replace', (pattern, replacement, subject, limit = -1, count = undefined) => replaceImpl('preg_replace', pattern, replacement, subject, limit, count, false), { refs: [false, false, false, false, true] });
def('preg_filter', (pattern, replacement, subject, limit = -1, count = undefined) => replaceImpl('preg_filter', pattern, replacement, subject, limit, count, false), { refs: [false, false, false, false, true] });
def('preg_replace_callback', (pattern, callback, subject, limit = -1, count = undefined, flags = 0) => replaceImpl('preg_replace_callback', pattern, callback, subject, limit, count, true, I(flags)), { refs: [false, false, false, false, true] });
def('preg_replace_callback_array', (pattern, subject, limit = -1, count = undefined, flags = 0) => {
  let s = subject, total = 0;
  for (const [p, cb] of A(pattern).entries()) {
    if (typeof p !== 'string') throwError('TypeError', 'preg_replace_callback_array(): Argument #1 ($pattern) must contain only string patterns as keys');
    if (!isCallable(cb)) throwError('TypeError', 'preg_replace_callback_array(): Argument #1 ($pattern) must contain only valid callbacks');
    const cnt = new Ref(0);
    s = replaceImpl('preg_replace_callback_array', p, cb, s, limit, cnt, true, I(flags));
    total += cnt.v;
    if (s === null) break;
  }
  if (count instanceof Ref) count.v = total;
  return s;
}, { refs: [false, false, false, true] });

// ------------------------------------------------------------------ preg_split
def('preg_split', (pattern, subject, limit = -1, flags = 0) => {
  callLimits = null;
  const c = pregCompile(S(pattern));
  if (!c) return false;
  pregLastError = 0;
  const s = S(subject);
  let lim = limit === null ? -1 : I(limit);
  if (lim === 0) lim = -1;
  const fl = I(flags);
  const noEmpty = (fl & PREG_SPLIT_NO_EMPTY) !== 0, delim = (fl & PREG_SPLIT_DELIM_CAPTURE) !== 0, offCap = (fl & PREG_SPLIT_OFFSET_CAPTURE) !== 0;
  const out = new PHPArray();
  const add = (st, en) => out.push(offCap ? PHPArray.from([st < 0 ? '' : s.slice(st, en), st]) : st < 0 ? '' : s.slice(st, en));
  const prep = checkSubject(c, s);
  if (!prep) return false;
  let lastMatch = 0, off = 0, opts = null;
  while (lim === -1 || lim > 1) {
    const m = matchAt(c, prep, off, opts);
    if (m === false) return false;
    if (m === null) {
      if (opts) { opts = null; if (off < s.length) { off += unitLen(prep, off); continue; } }
      break;
    }
    opts = null;
    if (m.ov[1] < m.ov[0]) { pregLastError = E_INTERNAL; return false; }
    if (!noEmpty || m.ov[0] !== lastMatch) {
      add(lastMatch, m.ov[0]);
      if (lim !== -1) lim--;
    }
    if (delim) {
      for (let g = 1; g < m.count; g++) {
        const st = m.ov[2 * g], en = m.ov[2 * g + 1];
        if (!noEmpty || st !== en) add(st, en);
      }
    }
    off = lastMatch = m.ov[1];
    if (m.ov[1] === m.ov[0]) {
      if (lim !== -1 && lim <= 1) break;
      opts = { notEmptyAtStart: true, anchored: true };
    }
  }
  if (!noEmpty || lastMatch < s.length) add(lastMatch, s.length);
  return out;
});

// ------------------------------------------------------------------ the rest
def('preg_quote', (str, delimiter = null) => {
  const d = delimiter === null ? '' : S(delimiter);
  const dc = d ? d[0] : '';
  let out = '';
  for (const ch of S(str)) {
    if (ch === '\0') out += '\\000';
    else if ('.\\+*?[^]$(){}=!<>|:-#/'.includes(ch) && ch !== '/') out += '\\' + ch;
    else if (dc && ch === dc) out += '\\' + ch;
    else out += ch;
  }
  return out;
});
def('preg_grep', (pattern, array, flags = 0) => {
  callLimits = null;
  const c = pregCompile(S(pattern));
  if (!c) return false;
  pregLastError = 0;
  const inv = (I(flags) & 1) !== 0;
  const out = new PHPArray();
  for (const [k, raw] of A(array).rawEntries()) {
    const v = raw instanceof Ref ? raw.v : raw;
    const m = matchAt(c, prepare(c, toStr(v)), 0, null);
    if (m === false) break;
    if ((m !== null) !== inv) { if (raw instanceof Ref) out.setRaw(k, raw); else out.set(k, v); }
  }
  return out;
});
def('preg_last_error', () => pregLastError);
def('preg_last_error_msg', () => PREG_ERR_MSG[pregLastError] || 'Unknown error');
