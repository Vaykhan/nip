// PCRE (preg_*): PHP regex patterns translated to JS RegExp.

import { PHPArray, Ref } from '../values.js';
import { toStr } from '../convert.js';
import { isValidUtf8, utf8Decode, utf8Encode } from '../utf8.js';
import { rt } from '../runtime/state.js';
import { warn } from '../runtime/errors.js';
import { callableFn } from '../runtime/callables.js';
import { A, def, I, S } from './core.js';

const PREG = { PATTERN_ORDER: 1, SET_ORDER: 2, OFFSET_CAPTURE: 256, UNMATCHED_AS_NULL: 512, SPLIT_NO_EMPTY: 1, SPLIT_DELIM_CAPTURE: 2, SPLIT_OFFSET_CAPTURE: 4, GREP_INVERT: 1 };
let pregLastError = 0;
export function resetPcreState() { pregLastError = 0; }
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
