// A backtracking regular expression engine with PCRE2 semantics, used by preg_*.
//
// Subjects are arrays of code units: bytes, or code points in UTF mode (the caller decodes
// UTF-8 and maps offsets back). Patterns are parsed into a tree, which is compiled into
// matcher closures taking a position and a continuation: m(i, k) returns true when the node
// matches at i and the continuation k succeeds for the end position, so backtracking is the
// return of false.

export class RegexSyntaxError {
  constructor(msg, offset) { this.msg = msg; this.offset = offset; }
}
// thrown by exec when the backtrack (match) limit or the recursion (depth) limit is reached
export class RegexLimitError {
  constructor(kind) { this.kind = kind; } // 'backtrack' | 'recursion' | 'jit'
}

// option bits (the scope of inline options like (?i) is a group)
const O_I = 1, O_M = 2, O_S = 4, O_X = 8, O_XX = 16, O_U = 32, O_N = 64, O_J = 128;

// ------------------------------------------------------------------ character properties
const NL = 10;
const isAsciiWord = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isAsciiDigit = (c) => c >= 48 && c <= 57;
const isAsciiSpace = (c) => c === 32 || (c >= 9 && c <= 13);
const H_SPACE = new Set([9, 32, 0xa0, 0x1680, 0x180e, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]);
const V_SPACE = new Set([10, 11, 12, 13, 0x85, 0x2028, 0x2029]);
const propCache = new Map();
// a Unicode property test, from JS's \p{...} support
function unicodeProp(name) {
  let t = propCache.get(name);
  if (t !== undefined) return t;
  let re;
  try { re = new RegExp(`^\\p{${name}}$`, 'u'); } catch (e) { re = null; }
  t = re ? (c) => re.test(String.fromCodePoint(c)) : null;
  propCache.set(name, t);
  return t;
}
const GC = new Set(['C', 'Cc', 'Cf', 'Cn', 'Co', 'Cs', 'L', 'Ll', 'Lm', 'Lo', 'Lt', 'Lu', 'M', 'Mc', 'Me', 'Mn', 'N', 'Nd', 'Nl', 'No',
  'P', 'Pc', 'Pd', 'Pe', 'Pf', 'Pi', 'Po', 'Ps', 'S', 'Sc', 'Sk', 'Sm', 'So', 'Z', 'Zl', 'Zp', 'Zs']);
const isL = (c) => unicodeProp('L')(c), isN = (c) => unicodeProp('N')(c);
const uWord = (c) => c === 95 || (c < 128 ? isAsciiWord(c) : isL(c) || isN(c));
const uDigit = (c) => (c < 128 ? isAsciiDigit(c) : unicodeProp('Nd')(c));
const uSpace = (c) => H_SPACE.has(c) || V_SPACE.has(c) || (c > 255 && unicodeProp('Z')(c));
// \p{name} as PCRE2 spells it, or null when unknown
function propertyTest(name) {
  const n = name.replace(/[\s_-]/g, '').toLowerCase();
  switch (n) {
    case 'any': return () => true;
    case 'l&': case 'lc': return (c) => unicodeProp('Lu')(c) || unicodeProp('Ll')(c) || unicodeProp('Lt')(c);
    case 'xan': return (c) => isL(c) || isN(c);
    case 'xwd': return (c) => c === 95 || isL(c) || isN(c);
    case 'xsp': case 'xps': return (c) => uSpace(c);
    case 'xuc': return (c) => c === 0x24 || c === 0x40 || c === 0x60 || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000);
  }
  for (const g of GC) if (g.toLowerCase() === n) return unicodeProp(g);
  const script = name.replace(/[\s-]/g, '_');
  const cand = [script, script[0].toUpperCase() + script.slice(1).toLowerCase(), script.replace(/(^|_)([a-z])/g, (m, a, b) => a + b.toUpperCase())];
  for (const s of cand) { const t = unicodeProp('Script=' + s); if (t) return t; }
  return null;
}
// simple case folding: two characters match caselessly when their folds are equal
function foldUtf(c) {
  if (c < 128) return c >= 65 && c <= 90 ? c + 32 : c;
  const s = String.fromCodePoint(c);
  const u = s.toUpperCase(), l = (u.length <= 2 && [...u].length === 1 ? u : s).toLowerCase();
  return [...l].length === 1 ? l.codePointAt(0) : c;
}
const foldAscii = (c) => (c >= 65 && c <= 90 ? c + 32 : c);
// the other case(s) of c, for caseless character classes
function otherCases(c, utf) {
  if (!utf || c < 128) {
    if (c >= 65 && c <= 90) return [c + 32];
    if (c >= 97 && c <= 122) return [c - 32];
    return [];
  }
  const s = String.fromCodePoint(c), out = new Set();
  for (const x of [s.toLowerCase(), s.toUpperCase()]) if ([...x].length === 1) out.add(x.codePointAt(0));
  if (c === 0x212a || c === 107 || c === 75) { out.add(107); out.add(75); out.add(0x212a); }
  if (c === 0x17f || c === 115 || c === 83) { out.add(115); out.add(83); out.add(0x17f); }
  out.delete(c);
  return [...out];
}

// POSIX classes: [ascii test, Unicode (UCP) test]
const POSIX = {
  alpha: [(c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122), isL],
  digit: [isAsciiDigit, (c) => unicodeProp('Nd')(c)],
  alnum: [(c) => isAsciiDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122), (c) => isL(c) || isN(c)],
  upper: [(c) => c >= 65 && c <= 90, (c) => unicodeProp('Lu')(c)],
  lower: [(c) => c >= 97 && c <= 122, (c) => unicodeProp('Ll')(c)],
  space: [isAsciiSpace, uSpace],
  blank: [(c) => c === 32 || c === 9, (c) => H_SPACE.has(c)],
  punct: [(c) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126), (c) => (c < 128 ? (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) : unicodeProp('P')(c))],
  xdigit: [(c) => isAsciiDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102), null],
  word: [isAsciiWord, uWord],
  cntrl: [(c) => c < 32 || c === 127, (c) => unicodeProp('Cc')(c)],
  print: [(c) => c >= 32 && c <= 126, (c) => (c < 128 ? c >= 32 && c <= 126 : !unicodeProp('C')(c))],
  graph: [(c) => c >= 33 && c <= 126, (c) => (c < 128 ? c >= 33 && c <= 126 : !unicodeProp('C')(c) && !unicodeProp('Z')(c))],
  ascii: [(c) => c < 128, null],
};

// ------------------------------------------------------------------ parser
const isDigitCp = (c) => c >= 48 && c <= 57;

class RegexParser {
  constructor(cps, offs, opts) {
    this.p = cps; this.offs = offs; this.i = 0; this.utf = opts.utf; this.ucp = opts.ucp;
    this.ncap = 0; this.names = []; // [{ name, num }]
    this.capNodes = []; // capture number -> group node (for recursion)
    this.refs = []; // nodes referring to groups by name/number, resolved after parsing
    this.hasBackrefTo = new Set();
    this.lookbehinds = [];
    this.newline = opts.newline || 'lf';
    this.bsrAnyCrlf = false;
    this.notEmpty = false;
  }
  off(i = this.i) { return i < this.offs.length ? this.offs[i] : this.offs[this.offs.length - 1]; }
  err(msg, i = this.i) { throw new RegexSyntaxError(msg, this.off(i)); }
  peek(k = 0) { return this.p[this.i + k]; }
  eof() { return this.i >= this.p.length; }
  is(s, k = 0) { for (let j = 0; j < s.length; j++) if (this.p[this.i + k + j] !== s.charCodeAt(j)) return false; return true; }
  skipX(opts) {
    if (!(opts & O_X)) return;
    for (;;) {
      const c = this.peek();
      if (c === undefined) return;
      if (c === 32 || (c >= 9 && c <= 13) || ((opts & O_XX) && false)) { this.i++; continue; }
      if (c === 0x23) { while (!this.eof() && this.peek() !== NL) this.i++; continue; }
      if (this.is('(?#')) { this.skipComment(); continue; }
      return;
    }
  }
  skipComment() {
    while (!this.eof() && this.peek() !== 0x29) this.i++;
    if (this.eof()) this.err('missing ) at end of (?# comment');
    this.i++;
  }
  // --- top level
  parse(opts) {
    this.leadingVerbs();
    const node = this.parseAlt(opts, { depth: 0 });
    if (!this.eof()) {
      if (this.peek() === 0x29) this.err('unmatched closing parenthesis');
      this.err('internal error: unexpected character');
    }
    return node;
  }
  // (*UTF), (*UCP), (*CRLF), ... at the start of the pattern
  leadingVerbs() {
    for (;;) {
      if (!this.is('(*')) return;
      const m = /^\(\*([A-Z_]+)(?:=(\d+))?\)/.exec(String.fromCharCode(...this.p.slice(this.i, this.i + 40)));
      if (!m) return;
      const name = m[1];
      switch (name) {
        case 'UTF': case 'UTF8': this.utf = true; this.wantUtf = true; break;
        case 'UCP': this.ucp = true; break;
        case 'CR': this.newline = 'cr'; break;
        case 'LF': this.newline = 'lf'; break;
        case 'CRLF': this.newline = 'crlf'; break;
        case 'ANYCRLF': this.newline = 'anycrlf'; break;
        case 'ANY': this.newline = 'any'; break;
        case 'NUL': this.newline = 'nul'; break;
        case 'BSR_ANYCRLF': this.bsrAnyCrlf = true; break;
        case 'BSR_UNICODE': this.bsrAnyCrlf = false; break;
        case 'NOTEMPTY': case 'NOTEMPTY_ATSTART': this.notEmpty = name; break;
        case 'NO_JIT': this.noJit = true; break;
        case 'NO_AUTO_POSSESS': case 'NO_DOTSTAR_ANCHOR': case 'NO_START_OPT': case 'LIMIT_MATCH': case 'LIMIT_DEPTH': case 'LIMIT_RECURSION': case 'LIMIT_HEAP': break;
        default: return;
      }
      this.i += m[0].length;
    }
  }
  parseAlt(opts, ctx) {
    const alts = [];
    const state = { opts };
    for (;;) {
      alts.push(this.parseSeq(state, ctx));
      if (this.peek() === 0x7c) { this.i++; if (ctx.branchReset) ctx.branchReset(); continue; }
      break;
    }
    return alts.length === 1 ? alts[0] : { t: 'alt', alts };
  }
  parseSeq(state, ctx) {
    const items = [];
    for (;;) {
      this.skipX(state.opts);
      if (this.eof()) break;
      const c = this.peek();
      if (c === 0x7c || c === 0x29) break;
      const start = this.i;
      // \Q...\E: literal run
      if (c === 0x5c && this.peek(1) === 0x51) {
        this.i += 2;
        const before = items.length;
        while (!this.eof() && !(this.peek() === 0x5c && this.peek(1) === 0x45)) items.push(this.lit(this.p[this.i++], state.opts));
        if (!this.eof()) this.i += 2;
        if (items.length > before) { this.skipX(state.opts); const last = items.pop(); last.repeatable = true; items.push(this.parseQuantifier(last, state.opts, start)); }
        continue;
      }
      if (c === 0x5c && this.peek(1) === 0x45) { this.i += 2; continue; }
      let atom = this.parseAtom(state, ctx);
      if (atom === null) continue; // option setting, comment
      this.skipX(state.opts);
      atom = this.parseQuantifier(atom, state.opts, start);
      items.push(atom);
    }
    return items.length === 1 ? items[0] : { t: 'seq', items };
  }
  lit(c, opts) {
    if (opts & O_I) {
      const others = otherCases(c, this.utf);
      if (others.length) return { t: 'char', c, ci: true };
    }
    return { t: 'char', c, ci: false };
  }
  parseQuantifier(atom, opts, atomStart) {
    let min, max;
    const c = this.peek(), qStart = this.i;
    if (c === 0x2a) { min = 0; max = Infinity; this.i++; }
    else if (c === 0x2b) { min = 1; max = Infinity; this.i++; }
    else if (c === 0x3f) { min = 0; max = 1; this.i++; }
    else if (c === 0x7b) {
      const q = this.braceQuantifier();
      if (!q) return atom;
      [min, max] = q;
    } else return atom;
    if (!atom.repeatable) {
      if (atom.t === 'look' || atom.t === 'cond') { /* assertions may be repeated (at most once matters) */ }
      else this.err('quantifier does not follow a repeatable item', qStart);
    }
    let greedy = true, possessive = false;
    if (this.peek() === 0x3f) { greedy = false; this.i++; }
    else if (this.peek() === 0x2b) { possessive = true; this.i++; }
    if ((opts & O_U) && !possessive) greedy = !greedy;
    if (atom.t === 'look') { if (min === 0) return { t: 'empty' }; return atom; }
    void atomStart;
    return { t: 'rep', body: atom, min, max, greedy, possessive, repeatable: false };
  }
  // {n}, {n,}, {n,m}; anything else is a literal "{"
  braceQuantifier() {
    let j = this.i + 1, a = '', b = null;
    while (isDigitCp(this.p[j])) a += String.fromCharCode(this.p[j++]);
    if (a === '') return null;
    if (this.p[j] === 0x2c) { j++; b = ''; while (isDigitCp(this.p[j])) b += String.fromCharCode(this.p[j++]); }
    if (this.p[j] !== 0x7d) return null;
    const min = +a, max = b === null ? min : b === '' ? Infinity : +b;
    if (min > 65535 || (max !== Infinity && max > 65535)) this.err('number too big in {} quantifier', j);
    if (max < min) this.err('numbers out of order in {} quantifier', j);
    this.i = j + 1;
    return [min, max];
  }
  parseAtom(state, ctx) {
    const opts = state.opts;
    const c = this.peek();
    switch (c) {
      case 0x28: return this.parseGroup(state, ctx);
      case 0x5b: this.i++; return this.parseClass(opts);
      case 0x2e: this.i++; return { t: 'any', dotall: !!(opts & O_S), nl: this.newline, repeatable: true };
      case 0x5e: this.i++; return { t: 'assert', kind: opts & O_M ? 'mbol' : 'bol', nl: this.newline };
      case 0x24: this.i++; return { t: 'assert', kind: opts & O_M ? 'meol' : 'eol', nl: this.newline };
      case 0x5c: return this.parseEscape(opts, ctx);
      case 0x2a: case 0x2b: case 0x3f:
        this.err('quantifier does not follow a repeatable item');
        break;
      case 0x7b:
        if (this.braceQuantifierAhead()) this.err('quantifier does not follow a repeatable item');
        break;
    }
    this.i++;
    const n = this.lit(c, opts);
    n.repeatable = true;
    return n;
  }
  braceQuantifierAhead() { const save = this.i; const q = this.braceQuantifier(); this.i = save; return !!q; }
  // --- groups
  parseGroup(state, ctx) {
    const start = this.i;
    this.i++; // (
    let opts = state.opts;
    if (this.peek() === 0x2a) return this.parseVerb(state, ctx, start);
    if (this.peek() !== 0x3f) {
      if (opts & O_N) return this.groupBody({ t: 'group', cap: 0, repeatable: true }, opts, ctx);
      return this.capture(null, opts, ctx);
    }
    this.i++; // ?
    const c = this.peek();
    switch (c) {
      case 0x23: this.skipComment(); return null;
      case 0x3a: this.i++; return this.groupBody({ t: 'group', cap: 0, repeatable: true }, opts, ctx);
      case 0x3e: this.i++; return this.groupBody({ t: 'atomic', repeatable: true }, opts, ctx);
      case 0x7c: this.i++; return this.branchReset(opts, ctx);
      case 0x3d: this.i++; return this.groupBody({ t: 'look', behind: false, neg: false }, opts, ctx);
      case 0x21: this.i++; return this.groupBody({ t: 'look', behind: false, neg: true }, opts, ctx);
      case 0x3c:
        if (this.peek(1) === 0x3d || this.peek(1) === 0x21) {
          const neg = this.peek(1) === 0x21;
          this.i += 2;
          const n = this.groupBody({ t: 'look', behind: true, neg, at: start }, opts, ctx);
          this.lookbehinds.push(n);
          return n;
        }
        this.i++;
        return this.capture(this.groupName(0x3e), opts, ctx);
      case 0x27: this.i++; return this.capture(this.groupName(0x27), opts, ctx);
      case 0x50: // P
        if (this.peek(1) === 0x3c) { this.i += 2; return this.capture(this.groupName(0x3e), opts, ctx); }
        if (this.peek(1) === 0x3d) { this.i += 2; const name = this.groupName(0x29); return this.ref({ t: 'backref', name, ci: !!(opts & O_I), repeatable: true }); }
        if (this.peek(1) === 0x3e) { this.i += 2; const name = this.groupName(0x29); return this.ref({ t: 'call', name, repeatable: true }); }
        this.err('unrecognized character after (?P', this.i + 1);
        break;
      case 0x26: { this.i++; const name = this.groupName(0x29); return this.ref({ t: 'call', name, repeatable: true }); }
      case 0x52: // R
        if (this.peek(1) === 0x29) { this.i += 2; return this.ref({ t: 'call', num: 0, repeatable: true }); }
        break;
      case 0x28: return this.parseConditional(opts, ctx, start);
      case 0x43: { // callout: ignored
        this.i++;
        if (this.peek() === 0x22 || this.peek() === 0x27 || this.peek() === 0x7b || this.peek() === 0x60 || this.peek() === 0x5e || this.peek() === 0x25 || this.peek() === 0x23 || this.peek() === 0x24) {
          const q = this.peek() === 0x7b ? 0x7d : this.peek(); this.i++;
          while (!this.eof() && this.peek() !== q) this.i++;
          this.i++;
        } else while (isDigitCp(this.peek())) this.i++;
        if (this.peek() !== 0x29) this.err('closing parenthesis for (?C expected');
        this.i++;
        return null;
      }
    }
    if (isDigitCp(c) || ((c === 0x2b || c === 0x2d) && isDigitCp(this.peek(1)))) {
      let sign = 0;
      if (c === 0x2b) { sign = 1; this.i++; } else if (c === 0x2d) { sign = -1; this.i++; }
      let n = 0;
      while (isDigitCp(this.peek())) n = n * 10 + this.p[this.i++] - 48;
      if (this.peek() !== 0x29) this.err('closing parenthesis for (?C expected'.replace('(?C', '(?'));
      this.i++;
      if (sign < 0) { n = this.ncap - n + 1; if (n <= 0) this.err('reference to non-existent subpattern', this.i - 1); }
      else if (sign > 0) n = this.ncap + n;
      return this.ref({ t: 'call', num: n, repeatable: true, at: this.i - 1 });
    }
    // option setting: (?imnsxUJ-imnsx) or (?imnsx:...)
    let on = true, j = this.i, nopts = opts;
    if (this.p[j] === 0x5e) { nopts &= ~(O_I | O_M | O_S | O_X | O_XX | O_N | O_U | O_J); j++; }
    for (;;) {
      const x = this.p[j];
      if (x === 0x29 || x === 0x3a) break;
      let bit = 0;
      switch (x) {
        case 0x69: bit = O_I; break;
        case 0x6d: bit = O_M; break;
        case 0x73: bit = O_S; break;
        case 0x78: bit = this.p[j + 1] === 0x78 ? O_X | O_XX : O_X; if (bit & O_XX) j++; break;
        case 0x55: bit = O_U; break;
        case 0x6e: bit = O_N; break;
        case 0x4a: bit = O_J; break;
        case 0x2d: if (!on) this.err('unrecognized character after (? or (?-', j); on = false; j++; continue;
        default: this.err('unrecognized character after (? or (?-', j);
      }
      if (on) nopts |= bit; else nopts &= ~bit;
      j++;
    }
    this.i = j + 1;
    if (this.p[j] === 0x29) { state.opts = nopts; return null; }
    return this.groupBody({ t: 'group', cap: 0, repeatable: true }, nopts, ctx);
  }
  groupName(term) {
    const s = this.i;
    let name = '';
    while (!this.eof() && this.peek() !== term) {
      const c = this.peek();
      if (!(isAsciiWord(c) || (this.utf && c > 127 && uWord(c)))) {
        if (name === '' && !isDigitCp(c)) this.err(`subpattern name expected`);
        this.err(`syntax error in subpattern name (missing terminator?)`);
      }
      name += String.fromCodePoint(c); this.i++;
    }
    if (name === '') this.err('subpattern name expected');
    if (isDigitCp(name.charCodeAt(0))) this.err('subpattern name must start with a non-digit', s);
    if (name.length > 32) this.err('subpattern name is too long (maximum 32 code units)');
    if (this.eof()) this.err('syntax error in subpattern name (missing terminator?)');
    this.i++;
    return name;
  }
  capture(name, opts, ctx) {
    const num = ++this.ncap;
    const node = { t: 'group', cap: num, name, repeatable: true };
    this.capNodes[num] = node;
    if (name !== null) {
      const ex = this.names.find((x) => x.name === name);
      if (ex && ex.num !== num && !(opts & O_J) && !ctx.inBranchReset) this.err('two named subpatterns have the same name (PCRE2_DUPNAMES not set)', this.i);
      if (!ex || ex.num !== num) this.names.push({ name, num });
    }
    return this.groupBody(node, opts, ctx);
  }
  groupBody(node, opts, ctx) {
    const look = node.t === 'look';
    if (look) this.lookDepth = (this.lookDepth || 0) + 1;
    node.body = this.parseAlt(opts, { depth: ctx.depth + 1 });
    if (look) this.lookDepth--;
    if (this.peek() !== 0x29) this.err('missing closing parenthesis');
    this.i++;
    return node;
  }
  branchReset(opts, ctx) {
    this.hasBranchReset = true;
    const base = this.ncap;
    let max = base;
    const node = { t: 'group', cap: 0, repeatable: true };
    const sub = { depth: ctx.depth + 1, inBranchReset: true, branchReset: () => { if (this.ncap > max) max = this.ncap; this.ncap = base; } };
    node.body = this.parseAlt(opts, sub);
    if (this.ncap > max) max = this.ncap;
    this.ncap = max;
    if (this.peek() !== 0x29) this.err('missing closing parenthesis');
    this.i++;
    return node;
  }
  ref(node) { this.refs.push(node); if (node.at === undefined) node.at = this.i; return node; }
  parseConditional(opts, ctx, start) {
    this.i++; // the inner (
    let cond;
    const c = this.peek();
    if (c === 0x3f && (this.peek(1) === 0x3d || this.peek(1) === 0x21 || (this.peek(1) === 0x3c && (this.peek(2) === 0x3d || this.peek(2) === 0x21)))) {
      // assertion condition
      this.i++;
      let behind = false;
      if (this.peek() === 0x3c) { behind = true; this.i++; }
      const neg = this.peek() === 0x21; this.i++;
      const look = this.groupBody({ t: 'look', behind, neg, at: this.i }, opts, ctx);
      if (behind) this.lookbehinds.push(look);
      cond = { kind: 'assert', look };
    } else if (c === 0x3f && this.peek(1) === 0x43) {
      this.i += 2; while (!this.eof() && this.peek() !== 0x29) this.i++; this.i++;
      if (!(this.is('(?=') || this.is('(?!') || this.is('(?<=') || this.is('(?<!'))) this.err('assertion expected after (?( or (?(?C)');
      this.i += 2;
      let behind = false;
      if (this.peek() === 0x3c) { behind = true; this.i++; }
      const neg = this.peek() === 0x21; this.i++;
      const look = this.groupBody({ t: 'look', behind, neg, at: this.i }, opts, ctx);
      if (behind) this.lookbehinds.push(look);
      cond = { kind: 'assert', look };
    } else {
      let s = '';
      const nameStart = this.i;
      while (!this.eof() && this.peek() !== 0x29) s += String.fromCodePoint(this.p[this.i++]);
      if (this.eof()) this.err('missing closing parenthesis for condition');
      this.i++;
      let m;
      if ((m = /^([+-]?)(\d+)$/.exec(s))) {
        let n = +m[2];
        if (m[1] === '-') n = this.ncap - n + 1; else if (m[1] === '+') n = this.ncap + n;
        if (n <= 0) this.err('reference to non-existent subpattern', nameStart);
        cond = this.ref({ kind: 'set', num: n, at: nameStart - 1 });
      } else if ((m = /^<([^>]+)>$/.exec(s)) || (m = /^'([^']+)'$/.exec(s))) cond = this.ref({ kind: 'set', name: m[1], at: nameStart });
      else if (s === 'R') cond = { kind: 'rec' };
      else if ((m = /^R(\d+)$/.exec(s))) cond = { kind: 'rec', num: +m[1] };
      else if ((m = /^R&(\w+)$/.exec(s))) cond = this.ref({ kind: 'rec', name: m[1], at: nameStart });
      else if (s === 'DEFINE') cond = { kind: 'define' };
      else if (/^\w+$/.test(s) && !isDigitCp(s.charCodeAt(0))) cond = this.ref({ kind: 'set', name: s, at: nameStart });
      else this.err('assertion expected after (?( or (?(?C)', nameStart);
    }
    const body = this.parseAlt(opts, { depth: ctx.depth + 1 });
    if (this.peek() !== 0x29) this.err('missing closing parenthesis');
    this.i++;
    const alts = body.t === 'alt' ? body.alts : [body];
    if (alts.length > 2) this.err('conditional subpattern contains more than two branches', this.i - 1);
    if (cond.kind === 'define' && alts.length > 1) this.err('DEFINE subpattern contains more than one branch', this.i - 1);
    void start;
    return { t: 'cond', cond, yes: alts[0], no: alts[1] || { t: 'empty' }, repeatable: true };
  }
  parseVerb(state, ctx, start) {
    this.i++; // *
    let name = '';
    while (!this.eof() && (isAsciiWord(this.peek()) || this.peek() === 0x5f)) name += String.fromCharCode(this.p[this.i++]);
    let arg = null;
    if (this.peek() === 0x3a) {
      this.i++;
      const lookName = name.toLowerCase();
      const ALPHA = { pla: [false, false], positive_lookahead: [false, false], nla: [false, true], negative_lookahead: [false, true], plb: [true, false], positive_lookbehind: [true, false], nlb: [true, true], negative_lookbehind: [true, true] };
      if (ALPHA[lookName]) {
        const [behind, neg] = ALPHA[lookName];
        const n = this.groupBody({ t: 'look', behind, neg, at: start }, state.opts, ctx);
        if (behind) this.lookbehinds.push(n);
        return n;
      }
      if (lookName === 'atomic') return this.groupBody({ t: 'atomic', repeatable: true }, state.opts, ctx);
      arg = '';
      while (!this.eof() && this.peek() !== 0x29) arg += String.fromCodePoint(this.p[this.i++]);
    }
    if (this.peek() !== 0x29) this.err('(*VERB) not recognized or malformed');
    if (!['F', 'FAIL', 'ACCEPT', 'COMMIT', 'PRUNE', 'SKIP', 'THEN', '', 'MARK'].includes(name)) this.err('(*VERB) not recognized or malformed');
    this.i++;
    switch (name) {
      case 'F': case 'FAIL': return { t: 'verb', v: 'FAIL', repeatable: false };
      case 'ACCEPT': this.hasAccept = true; return { t: 'verb', v: 'ACCEPT', repeatable: false };
      case 'COMMIT': return { t: 'verb', v: 'COMMIT', arg };
      case 'PRUNE': return { t: 'verb', v: 'PRUNE', arg };
      case 'SKIP': return { t: 'verb', v: 'SKIP', arg };
      case 'THEN': return { t: 'verb', v: 'THEN', arg };
      case '': case 'MARK':
        if (arg === null || arg === '') this.err('(*MARK) must have an argument');
        return { t: 'verb', v: 'MARK', arg };
    }
    this.err('(*VERB) not recognized or malformed');
  }
  // --- escapes
  parseEscape(opts, ctx) {
    const at = this.i;
    this.i++;
    if (this.eof()) this.err('\\ at end of pattern');
    const c = this.p[this.i++];
    const s = String.fromCharCode(c);
    const set = (test, neg = false) => ({ t: 'set', test: neg ? (x) => !test(x) : test, repeatable: true });
    const ucp = this.ucp;
    switch (s) {
      case 'd': return set(ucp ? uDigit : isAsciiDigit);
      case 'D': return set(ucp ? uDigit : isAsciiDigit, true);
      case 's': return set(ucp ? uSpace : isAsciiSpace);
      case 'S': return set(ucp ? uSpace : isAsciiSpace, true);
      case 'w': return set(ucp ? uWord : isAsciiWord);
      case 'W': return set(ucp ? uWord : isAsciiWord, true);
      case 'h': return set((x) => H_SPACE.has(x) && (this.utf || x < 256));
      case 'H': return set((x) => H_SPACE.has(x) && (this.utf || x < 256), true);
      case 'v': return set((x) => V_SPACE.has(x) && (this.utf || x < 256));
      case 'V': return set((x) => V_SPACE.has(x) && (this.utf || x < 256), true);
      case 'N':
        if (this.peek() === 0x7b) {
          const m = /^\{U\+([0-9A-Fa-f]+)\}/.exec(String.fromCharCode(...this.p.slice(this.i, this.i + 12)));
          if (m && this.utf) { this.i += m[0].length; const n = this.lit(parseInt(m[1], 16), opts); n.repeatable = true; return n; }
          if (!this.braceQuantifierAhead()) this.err('PCRE2 does not support \\F, \\L, \\l, \\N{name}, \\U, or \\u');
        }
        return { t: 'any', dotall: false, nl: this.newline, repeatable: true };
      case 'R': return { t: 'bsr', anycrlf: this.bsrAnyCrlf, repeatable: true };
      case 'X': return { t: 'grapheme', repeatable: true };
      case 'C': return { t: 'any', dotall: true, repeatable: true };
      case 'p': case 'P': return set(this.property(), s === 'P');
      case 'b': return { t: 'assert', kind: 'wordb', ucp };
      case 'B': return { t: 'assert', kind: 'nwordb', ucp };
      case 'A': return { t: 'assert', kind: 'start' };
      case 'z': return { t: 'assert', kind: 'end' };
      case 'Z': return { t: 'assert', kind: 'endnl', nl: this.newline };
      case 'G': return { t: 'assert', kind: 'G' };
      case 'K': return { t: 'keep' };
      case 'g': return this.escapeG(opts);
      case 'k': {
        const open = this.peek();
        const close = open === 0x3c ? 0x3e : open === 0x27 ? 0x27 : open === 0x7b ? 0x7d : -1;
        if (close < 0) this.err('\\k is not followed by a braced, angle-bracketed, or quoted name');
        this.i++;
        const at = this.i;
        return this.ref({ t: 'backref', name: this.groupName(close), ci: !!(opts & O_I), repeatable: true, at });
      }
      case 'F': case 'L': case 'l': case 'U': case 'u':
        this.err('PCRE2 does not support \\F, \\L, \\l, \\N{name}, \\U, or \\u');
    }
    if (c >= 0x31 && c <= 0x39) {
      // backreference, or octal
      const ds = this.i - 1;
      let n = c - 48;
      while (isDigitCp(this.peek())) n = n * 10 + this.p[this.i++] - 48;
      if (n < 10 || n <= this.ncap) return this.ref({ t: 'backref', num: n, ci: !!(opts & O_I), repeatable: true, at: ds });
      this.i = ds;
      if (c >= 0x38) { this.i++; const x = this.lit(c, opts); x.repeatable = true; return x; }
      let v = 0, k = 0;
      while (k < 3 && this.peek() >= 0x30 && this.peek() <= 0x37) { v = v * 8 + this.p[this.i++] - 48; k++; }
      return this.charNode(v, opts, at);
    }
    this.i = at;
    const v = this.escapeChar(false);
    return this.charNode(v, opts, at);
  }
  charNode(v, opts, at) {
    if (!this.utf && v > 255) this.err('character code point value in \\x{} or \\o{} is too large', at + 1);
    const n = this.lit(v, opts);
    n.repeatable = true;
    return n;
  }
  // an escape that stands for one character (also inside classes); this.i is at the backslash
  escapeChar(inClass) {
    const at = this.i;
    this.i++;
    const c = this.p[this.i++];
    switch (String.fromCharCode(c)) {
      case 'a': return 7;
      case 'e': return 27;
      case 'f': return 12;
      case 'n': return 10;
      case 'r': return 13;
      case 't': return 9;
      case 'b': if (inClass) return 8; break;
      case '0': { let v = 0, k = 0; while (k < 2 && this.peek() >= 0x30 && this.peek() <= 0x37) { v = v * 8 + this.p[this.i++] - 48; k++; } return v; }
      case 'o': {
        if (this.peek() !== 0x7b) this.err('missing opening brace after \\o');
        this.i++;
        let v = 0, any = false;
        while (this.peek() >= 0x30 && this.peek() <= 0x37) { v = v * 8 + this.p[this.i++] - 48; any = true; }
        if (this.peek() !== 0x7d || !any) this.err(any ? 'non-octal character in \\o{} (closing brace missing?)' : 'digits missing in \\x{} or \\o{} or \\N{U+}');
        this.i++;
        if (!this.utf && v > 255) this.err('character code point value in \\x{} or \\o{} is too large');
        return v;
      }
      case 'x': {
        const hex = (x) => (x >= 48 && x <= 57) || (x >= 65 && x <= 70) || (x >= 97 && x <= 102);
        if (this.peek() === 0x7b) {
          this.i++;
          let v = 0, any = false;
          while (hex(this.peek())) { v = v * 16 + parseInt(String.fromCharCode(this.p[this.i++]), 16); any = true; if (v > 0x10ffff) this.err('character code point value in \\x{} or \\o{} is too large'); }
          if (this.peek() !== 0x7d || !any) this.err(any ? 'non-hex character in \\x{} (closing brace missing?)' : 'digits missing in \\x{} or \\o{} or \\N{U+}');
          this.i++;
          if (!this.utf && v > 255) this.err('character code point value in \\x{} or \\o{} is too large');
          if (this.utf && v >= 0xd800 && v <= 0xdfff) this.err('disallowed Unicode code point (>= 0xd800 && <= 0xdfff)');
          return v;
        }
        let v = 0, k = 0;
        while (k < 2 && hex(this.peek())) { v = v * 16 + parseInt(String.fromCharCode(this.p[this.i++]), 16); k++; }
        return v;
      }
      case 'c': {
        const x = this.p[this.i++];
        if (x === undefined) this.err('\\c at end of pattern');
        if (x > 126 || x < 32) this.err('\\c must be followed by a printable ASCII character');
        return (x >= 97 && x <= 122 ? x - 32 : x) ^ 0x40;
      }
    }
    if (c === undefined) this.err('\\ at end of pattern', at);
    if (isAsciiWord(c) && c !== 95) {
      if (inClass && c >= 0x31 && c <= 0x37) { this.i--; let v = 0, k = 0; while (k < 3 && this.peek() >= 0x30 && this.peek() <= 0x37) { v = v * 8 + this.p[this.i++] - 48; k++; } return v; }
      if (inClass && (c === 0x38 || c === 0x39)) return c;
      this.err('unrecognized character follows \\', this.i - 1);
    }
    return c;
  }
  escapeG(opts) {
    const open = this.peek();
    if (open === 0x3c || open === 0x27) {
      // \g<name> \g<n>: subroutine call
      this.i++;
      const close = open === 0x3c ? 0x3e : 0x27;
      let s = '';
      while (!this.eof() && this.peek() !== close) s += String.fromCodePoint(this.p[this.i++]);
      if (this.eof()) this.err('\\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number');
      this.i++;
      const m = /^([+-]?)(\d+)$/.exec(s);
      if (m) {
        let n = +m[2];
        if (m[1] === '-') n = this.ncap - n + 1; else if (m[1] === '+') n = this.ncap + n;
        return this.ref({ t: 'call', num: n, repeatable: true });
      }
      return this.ref({ t: 'call', name: s, repeatable: true });
    }
    let s = '';
    if (open === 0x7b) {
      this.i++;
      while (!this.eof() && this.peek() !== 0x7d) s += String.fromCodePoint(this.p[this.i++]);
      this.i++;
    } else {
      if (this.peek() === 0x2d || this.peek() === 0x2b) s += String.fromCharCode(this.p[this.i++]);
      while (isDigitCp(this.peek())) s += String.fromCharCode(this.p[this.i++]);
    }
    const m = /^([+-]?)(\d+)$/.exec(s);
    if (m) {
      let n = +m[2];
      if (m[1] === '-') { n = this.ncap - n + 1; if (n <= 0) this.err('reference to non-existent subpattern'); }
      else if (m[1] === '+') this.err('a relative value of zero is not allowed');
      if (n === 0) this.err('a relative value of zero is not allowed');
      return this.ref({ t: 'backref', num: n, ci: !!(opts & O_I), repeatable: true });
    }
    if (!s) this.err('\\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number');
    return this.ref({ t: 'backref', name: s, ci: !!(opts & O_I), repeatable: true });
  }
  property() {
    let name;
    if (this.peek() === 0x7b) {
      const s = this.i;
      while (!this.eof() && this.peek() !== 0x7d) this.i++;
      if (this.eof()) this.err('malformed \\P or \\p sequence', s);
      name = String.fromCodePoint(...this.p.slice(s + 1, this.i));
      this.i++;
    } else {
      if (this.eof()) this.err('malformed \\P or \\p sequence');
      name = String.fromCodePoint(this.p[this.i++]);
    }
    let neg = false;
    if (name[0] === '^') { neg = true; name = name.slice(1); }
    const t = propertyTest(name);
    if (!t) this.err('unknown property after \\P or \\p');
    return neg ? (c) => !t(c) : t;
  }
  // --- character classes
  parseClass(opts) {
    const start = this.i - 1;
    let neg = false;
    if (this.peek() === 0x5e) { neg = true; this.i++; }
    const ranges = []; // [lo, hi]
    const tests = [];
    let first = true;
    const ucp = this.ucp;
    for (;;) {
      if (this.eof()) this.err('missing terminating ] for character class', this.p.length);
      let c = this.peek();
      if (c === 0x5d && !first) { this.i++; break; }
      first = false;
      if ((opts & O_XX) && (c === 32 || c === 9)) { this.i++; continue; }
      // POSIX class
      if (c === 0x5b && (this.peek(1) === 0x3a || this.peek(1) === 0x2e || this.peek(1) === 0x3d)) {
        const kind = this.peek(1);
        let j = this.i + 2;
        while (j < this.p.length && this.p[j] !== kind && this.p[j] !== 0x5d) j++;
        if (this.p[j] === kind && this.p[j + 1] === 0x5d) {
          if (kind !== 0x3a) this.err('POSIX collating elements are not supported', this.i);
          let name = String.fromCharCode(...this.p.slice(this.i + 2, j));
          let pneg = false;
          if (name[0] === '^') { pneg = true; name = name.slice(1); }
          const pc = POSIX[name];
          if (!pc) this.err('unknown POSIX class name', this.i + 2);
          let t = (ucp && pc[1]) || pc[0];
          if ((opts & O_I) && (name === 'upper' || name === 'lower')) t = POSIX.alpha[ucp ? 1 : 0];
          tests.push(pneg ? (x) => !t(x) : t);
          this.i = j + 2;
          continue;
        }
      }
      let lo;
      if (c === 0x5c) {
        const e = this.peek(1);
        const es = String.fromCharCode(e);
        const typeTest = { d: ucp ? uDigit : isAsciiDigit, s: ucp ? uSpace : isAsciiSpace, w: ucp ? uWord : isAsciiWord, h: (x) => H_SPACE.has(x) && (this.utf || x < 256), v: (x) => V_SPACE.has(x) && (this.utf || x < 256) }[es.toLowerCase()];
        if (typeTest && 'dswhvDSWHV'.includes(es)) {
          this.i += 2;
          tests.push(es === es.toUpperCase() ? (x) => !typeTest(x) : typeTest);
          if (this.peek() === 0x2d && this.peek(1) !== 0x5d) this.err('invalid range in character class', this.i + 1);
          continue;
        }
        if (es === 'p' || es === 'P') { this.i += 2; const t = this.property(); tests.push(es === 'P' ? (x) => !t(x) : t); continue; }
        if (es === 'Q') {
          this.i += 2;
          while (!this.eof() && !(this.peek() === 0x5c && this.peek(1) === 0x45)) { const x = this.p[this.i++]; ranges.push([x, x]); }
          if (!this.eof()) this.i += 2;
          continue;
        }
        if (es === 'E') { this.i += 2; continue; }
        if (es === 'N') this.err('escape sequence is invalid in character class', this.i + 1);
        if (es === 'R' || es === 'X' || es === 'B') this.err('escape sequence is invalid in character class', this.i + 1);
        lo = this.escapeChar(true);
      } else { lo = c; this.i++; }
      // range?
      if (this.peek() === 0x2d && this.peek(1) !== 0x5d && this.peek(1) !== undefined) {
        const save = this.i;
        this.i++;
        let hi;
        const c2 = this.peek();
        if (c2 === 0x5b && this.peek(1) === 0x3a) { this.i = save; ranges.push([lo, lo]); continue; }
        if (c2 === 0x5c) {
          const e = String.fromCharCode(this.peek(1));
          if ('dswhvDSWHVpP'.includes(e)) this.err('invalid range in character class', this.i + 1);
          if (e === 'Q' || e === 'E') { this.i = save; ranges.push([lo, lo]); continue; }
          hi = this.escapeChar(true);
        } else { hi = c2; this.i++; }
        if (hi < lo) this.err('range out of order in character class', this.i - 1);
        ranges.push([lo, hi]);
        continue;
      }
      ranges.push([lo, lo]);
    }
    if (opts & O_I) {
      const extra = [];
      for (const [lo, hi] of ranges) {
        if (hi - lo > 5000) { extra.push([lo, hi, true]); continue; }
        for (let x = lo; x <= hi; x++) for (const o of otherCases(x, this.utf)) extra.push([o, o]);
      }
      for (const e of extra) {
        if (e[2]) { const [lo, hi] = e; tests.push((x) => { for (const o of otherCases(x, this.utf)) if (o >= lo && o <= hi) return true; return false; }); }
        else ranges.push(e);
      }
    }
    void start;
    return { t: 'set', test: makeClassTest(ranges, tests, neg, this.utf), repeatable: true };
  }
}
function makeClassTest(ranges, tests, neg, utf) {
  // a bitmap for the first 256 code units, then the ranges and tests
  const bm = new Uint8Array(256);
  for (const [lo, hi] of ranges) for (let x = lo; x <= Math.min(hi, 255); x++) bm[x] = 1;
  for (const t of tests) for (let x = 0; x < 256; x++) if (!bm[x] && t(x)) bm[x] = 1;
  const big = ranges.filter(([, hi]) => hi > 255);
  if (!utf) return neg ? (x) => bm[x] === 0 : (x) => bm[x] === 1;
  const slow = (x) => { for (const [lo, hi] of big) if (x >= lo && x <= hi) return true; for (const t of tests) if (t(x)) return true; return false; };
  return neg ? (x) => (x < 256 ? bm[x] === 0 : !slow(x)) : (x) => (x < 256 ? bm[x] === 1 : slow(x));
}

// ------------------------------------------------------------------ analysis
// fixed length of a node (in code units), or -1 when it varies; used for lookbehinds
function fixedLength(n, P, seen = new Set()) {
  switch (n.t) {
    case 'char': case 'any': case 'set': return 1;
    case 'empty': case 'assert': case 'look': case 'keep': case 'verb': return 0;
    case 'seq': { let s = 0; for (const x of n.items) { const l = fixedLength(x, P, seen); if (l < 0) return -1; s += l; } return s; }
    case 'alt': { let l0 = null; for (const a of n.alts) { const l = fixedLength(a, P, seen); if (l < 0 || (l0 !== null && l !== l0)) return -1; l0 = l; } return l0 || 0; }
    case 'group': case 'atomic': return fixedLength(n.body, P, seen);
    case 'rep': { if (n.min !== n.max) return -1; const l = fixedLength(n.body, P, seen); return l < 0 ? -1 : l * n.min; }
    case 'cond': { const a = fixedLength(n.yes, P, seen), b = fixedLength(n.no, P, seen); return a >= 0 && a === b ? a : -1; }
    case 'call': {
      if (seen.has(n.num)) return -1;
      seen.add(n.num);
      const g = n.num === 0 ? P.root : P.capNodes[n.num];
      const l = g ? fixedLength(g.body || g, P, seen) : -1;
      seen.delete(n.num);
      return l;
    }
  }
  return -1;
}
// can the node match the empty string? (for the "recursive call could loop indefinitely" check)
function canBeEmpty(n) {
  switch (n.t) {
    case 'char': case 'any': case 'set': case 'bsr': case 'grapheme': return false;
    case 'seq': return n.items.every(canBeEmpty);
    case 'alt': return n.alts.some(canBeEmpty);
    case 'group': case 'atomic': return canBeEmpty(n.body);
    case 'rep': return n.min === 0 || canBeEmpty(n.body);
    case 'backref': case 'call': return true;
  }
  return true;
}

// ------------------------------------------------------------------ matcher
// state of the running match (exec isn't re-entrant: callbacks run between matches)
let SUBJ = null, SLEN = 0, caps = null, steps = 0, stepLimit = 0, depth = 0, depthLimit = 0;
let startOff = 0, matchStart = 0, mark = null, verb = 0, skipTo = -1, recStack = [];
let notEmptyAtStart = false, notEmpty = false, acceptK = [], thenAlt = 0, openGroups = [];
const V_COMMIT = 1, V_PRUNE = 2, V_SKIP = 3, V_THEN = 4;
// PHP matches with PCRE2's JIT by default (pcre.jit=1), which ignores the depth limit but runs
// out of its 192 KiB stack on deeply nested backtracking; these frame sizes approximate it
let jitMode = false, jitStack = 0;
const JIT_STACK_MAX = 192 * 1024, JIT_CAP_FRAME = 32, JIT_GROUP_FRAME = 8, JIT_ALT_FRAME = 24;

function isNlAt(i, nl) {
  const c = SUBJ[i];
  switch (nl) {
    case 'lf': return c === 10;
    case 'cr': return c === 13;
    case 'crlf': return c === 13 && SUBJ[i + 1] === 10;
    case 'anycrlf': return c === 10 || c === 13;
    case 'any': return c === 10 || c === 11 || c === 12 || c === 13 || c === 0x85 || c === 0x2028 || c === 0x2029;
    case 'nul': return c === 0;
  }
  return c === 10;
}
// is there a newline ending at i (for ^ in multiline mode)?
function nlBefore(i, nl) {
  if (i <= 0) return false;
  if (nl === 'crlf') return i >= 2 && SUBJ[i - 2] === 13 && SUBJ[i - 1] === 10;
  if ((nl === 'anycrlf' || nl === 'any') && SUBJ[i - 1] === 10 && SUBJ[i - 2] === 13) return true;
  return isNlAt(i - 1, nl);
}
const nlLen = (i, nl) => ((nl === 'crlf' || nl === 'anycrlf' || nl === 'any') && SUBJ[i] === 13 && SUBJ[i + 1] === 10 ? 2 : 1);
function wordAt(i, ucp) { if (i < 0 || i >= SLEN) return false; const c = SUBJ[i]; return ucp ? uWord(c) : c < 256 && isAsciiWord(c); }
function reTick() {
  if (++steps > stepLimit) throw new RegexLimitError('backtrack');
}

class RegexCompiler {
  constructor(P, utf) { this.P = P; this.utf = utf; this.groupMatchers = []; this.altIds = 0; this.altStack = []; this.track = !!P.hasAccept; }
  // node -> (i, k) => boolean
  c(n) {
    switch (n.t) {
      case 'empty': return (i, k) => k(i);
      case '__m': return n.m; // an already compiled matcher
      case 'char': {
        const cc = n.c;
        if (n.ci) {
          const f = this.utf ? foldUtf : foldAscii, fc = f(cc);
          return (i, k) => i < SLEN && (SUBJ[i] === cc || f(SUBJ[i]) === fc) && k(i + 1);
        }
        return (i, k) => i < SLEN && SUBJ[i] === cc && k(i + 1);
      }
      case 'any': {
        if (n.dotall) return (i, k) => i < SLEN && k(i + 1);
        const nl = n.nl;
        if (nl === 'lf' || !nl) return (i, k) => i < SLEN && SUBJ[i] !== NL && k(i + 1);
        return (i, k) => i < SLEN && !isNlAt(i, nl) && k(i + 1);
      }
      case 'set': { const t = n.test; return (i, k) => i < SLEN && t(SUBJ[i]) && k(i + 1); }
      case 'bsr': {
        const any = !n.anycrlf;
        return (i, k) => {
          if (i >= SLEN) return false;
          const c = SUBJ[i];
          if (c === 13) return k(SUBJ[i + 1] === 10 ? i + 2 : i + 1);
          if (c === 10 || (any && (c === 11 || c === 12 || c === 0x85 || (this.utf && (c === 0x2028 || c === 0x2029))))) return k(i + 1);
          return false;
        };
      }
      case 'grapheme': {
        const isM = unicodeProp('M');
        return (i, k) => {
          if (i >= SLEN) return false;
          let j = i + 1;
          if (SUBJ[i] === 13 && SUBJ[j] === 10) return k(j + 1);
          if (this.utf) while (j < SLEN && (isM(SUBJ[j]) || SUBJ[j] === 0x200d || (SUBJ[j - 1] === 0x200d && j < SLEN))) j++;
          return k(j);
        };
      }
      case 'seq': return this.seq(n.items);
      case 'alt': {
        const id = ++this.altIds;
        this.altStack.push(id);
        const ms = n.alts.map((a) => this.c(a));
        this.altStack.pop();
        return (i, k) => {
          if (jitMode && (jitStack += JIT_ALT_FRAME) > JIT_STACK_MAX) throw new RegexLimitError('jit');
          for (let a = 0; a < ms.length; a++) {
            reTick();
            if (ms[a](i, k)) { if (jitMode) jitStack -= JIT_ALT_FRAME; return true; }
            if (verb) { if (verb === V_THEN && thenAlt === id) { verb = 0; continue; } break; }
          }
          if (jitMode) jitStack -= JIT_ALT_FRAME;
          return false;
        };
      }
      case 'group': {
        const inner = this.c(n.body);
        const cost = n.cap ? JIT_CAP_FRAME : JIT_GROUP_FRAME;
        const body = (i, k) => {
          if (jitMode) {
            if ((jitStack += cost) > JIT_STACK_MAX) throw new RegexLimitError('jit');
            const r = inner(i, k);
            jitStack -= cost;
            return r;
          }
          if (++depth > depthLimit) throw new RegexLimitError('recursion');
          const r = inner(i, k);
          depth--;
          return r;
        };
        if (!n.cap) return body;
        const s = 2 * n.cap, e = s + 1;
        this.groupMatchers[n.cap] = body;
        if (this.track) {
          // with (*ACCEPT), the groups open when it's reached are captured up to there
          const cap = n.cap;
          return (i, k) => {
            const entry = { cap, start: i };
            openGroups.push(entry);
            const r = body(i, (j) => {
              const ps = caps[s], pe = caps[e];
              caps[s] = i; caps[e] = j;
              openGroups.pop();
              if (k(j)) return true;
              openGroups.push(entry);
              caps[s] = ps; caps[e] = pe;
              return false;
            });
            if (!r) openGroups.pop();
            return r;
          };
        }
        return (i, k) => body(i, (j) => {
          const ps = caps[s], pe = caps[e];
          caps[s] = i; caps[e] = j;
          if (k(j)) return true;
          caps[s] = ps; caps[e] = pe;
          return false;
        });
      }
      case 'atomic': {
        const body = this.c(n.body);
        return (i, k) => {
          const saved = caps.slice();
          let end = -1;
          if (!body(i, (j) => { end = j; return true; })) { if (verb === V_THEN) verb = 0; return false; }
          if (k(end)) return true;
          caps.set(saved);
          return false;
        };
      }
      case 'look': return this.look(n);
      case 'rep': return this.rep(n);
      case 'assert': return this.assert(n);
      case 'keep': return (i, k) => { const old = matchStart; matchStart = i; if (k(i)) return true; matchStart = old; return false; };
      case 'backref': {
        const nums = n.nums, ci = n.ci, f = this.utf ? foldUtf : foldAscii;
        return (i, k) => {
          let s = -1, e = -1;
          for (const num of nums) if (caps[2 * num + 1] >= 0) { s = caps[2 * num]; e = caps[2 * num + 1]; break; }
          if (s < 0) return false;
          const len = e - s;
          if (i + len > SLEN) return false;
          for (let x = 0; x < len; x++) {
            const a = SUBJ[s + x], b = SUBJ[i + x];
            if (a !== b && !(ci && f(a) === f(b))) return false;
          }
          return k(i + len);
        };
      }
      case 'call': {
        const num = n.num;
        let target = null;
        return (i, k) => {
          if (target === null) target = num === 0 ? this.root : this.groupMatchers[num] || this.c(this.P.capNodes[num].body);
          if (++depth > depthLimit) throw new RegexLimitError('recursion');
          // a recursion into the same group at the same position would loop forever
          for (let r = recStack.length - 1; r >= 0; r--) if (recStack[r].num === num && recStack[r].pos === i) { depth--; return false; }
          const saved = caps.slice();
          recStack.push({ num, pos: i });
          const frame = recStack[recStack.length - 1];
          const ret = (j) => {
            const inner = caps.slice();
            caps.set(saved);
            recStack.pop(); acceptK.pop();
            const ok = k(j);
            recStack.push(frame); acceptK.push(acc);
            if (ok) return true;
            caps.set(inner);
            return false;
          };
          const acc = { k: ret, groups: openGroups.length };
          acceptK.push(acc);
          const r = target(i, ret);
          recStack.pop(); acceptK.pop();
          depth--;
          if (!r) caps.set(saved);
          return r;
        };
      }
      case 'cond': return this.cond(n);
      case 'verb': return this.verb(n);
    }
    throw new Error('regex: unknown node ' + n.t);
  }
  seq(items) {
    // merge runs of plain characters into one comparison
    const parts = [];
    for (const it of items) {
      const last = parts[parts.length - 1];
      if (it.t === 'char' && !it.ci && last && last.t === 'str') last.cs.push(it.c);
      else if (it.t === 'char' && !it.ci) parts.push({ t: 'str', cs: [it.c] });
      else parts.push(it);
    }
    const ms = parts.map((p) => {
      if (p.t !== 'str') return this.c(p);
      if (p.cs.length === 1) return this.c({ t: 'char', c: p.cs[0], ci: false });
      const cs = p.cs, L = cs.length;
      return (i, k) => {
        if (i + L > SLEN) return false;
        for (let x = 0; x < L; x++) if (SUBJ[i + x] !== cs[x]) return false;
        return k(i + L);
      };
    });
    if (ms.length === 0) return (i, k) => k(i);
    if (ms.length === 1) return ms[0];
    let m = ms[ms.length - 1];
    for (let x = ms.length - 2; x >= 0; x--) {
      const a = ms[x], b = m;
      m = (i, k) => a(i, (j) => b(j, k));
    }
    return m;
  }
  look(n) {
    const neg = n.neg;
    if (!n.behind) {
      const body = this.c(n.body);
      return (i, k) => {
        const saved = caps.slice(), savedStart = matchStart;
        acceptK.push({ k: () => true, groups: openGroups.length });
        let ok;
        try { ok = body(i, () => true); } finally { acceptK.pop(); }
        if (verb && verb !== V_THEN) { if (!neg || ok) return false; }
        verb = 0;
        if (neg) { matchStart = savedStart; caps.set(saved); return ok ? false : k(i); }
        if (!ok) { matchStart = savedStart; caps.set(saved); return false; }
        if (k(i)) return true;
        matchStart = savedStart;
        caps.set(saved);
        return false;
      };
    }
    // lookbehind: each alternative has a fixed length
    const alts = n.body.t === 'alt' ? n.body.alts : [n.body];
    const ms = alts.map((a) => [fixedLength(a, this.P), this.c(a)]);
    return (i, k) => {
      const saved = caps.slice(), savedStart = matchStart;
      let ok = false;
      acceptK.push({ k: () => true, groups: openGroups.length });
      try {
        for (const [len, m] of ms) {
          if (i - len < 0) continue;
          if (m(i - len, (j) => j === i)) { ok = true; break; }
        }
      } finally { acceptK.pop(); }
      verb = 0;
      matchStart = savedStart;
      if (neg) { caps.set(saved); return ok ? false : k(i); }
      if (!ok) { caps.set(saved); return false; }
      if (k(i)) return true;
      caps.set(saved);
      return false;
    };
  }
  rep(n) {
    const { min, max } = n;
    const b = n.body;
    // single-character bodies: count the run, then try the continuation from each length
    if ((b.t === 'char' || b.t === 'set' || b.t === 'any') && !(b.t === 'any' && b.nl && b.nl !== 'lf' && !b.dotall)) {
      let t;
      if (b.t === 'char') {
        const cc = b.c;
        if (b.ci) { const f = this.utf ? foldUtf : foldAscii, fc = f(cc); t = (x) => x === cc || f(x) === fc; }
        else t = (x) => x === cc;
      } else if (b.t === 'set') t = b.test;
      else t = b.dotall ? () => true : (x) => x !== NL;
      if (n.possessive) {
        return (i, k) => {
          let c = 0;
          while (c < max && i + c < SLEN && t(SUBJ[i + c])) c++;
          return c >= min && k(i + c);
        };
      }
      if (n.greedy) {
        return (i, k) => {
          let c = 0;
          while (c < max && i + c < SLEN && t(SUBJ[i + c])) c++;
          for (; c >= min; c--) {
            reTick();
            if (k(i + c)) return true;
            if (verb) return false;
          }
          return false;
        };
      }
      return (i, k) => {
        let c = 0;
        while (c < min) { if (i + c >= SLEN || !t(SUBJ[i + c])) return false; c++; }
        for (;;) {
          reTick();
          if (k(i + c)) return true;
          if (verb) return false;
          if (c >= max || i + c >= SLEN || !t(SUBJ[i + c])) return false;
          c++;
        }
      };
    }
    const body = this.c(b);
    if (n.possessive) {
      const inner = this.rep({ ...n, possessive: false, greedy: true });
      return this.c({ t: 'atomic', body: { t: '__m', m: inner } });
    }
    const greedy = n.greedy;
    const loop = (i, count, k) => {
      reTick();
      if (count < min) return body(i, (j) => loop(j, count + 1, k));
      if (greedy) {
        if (count < max && body(i, (j) => (j === i ? k(j) : loop(j, count + 1, k)))) return true;
        if (verb) return false;
        return k(i);
      }
      if (k(i)) return true;
      if (verb) return false;
      return count < max && body(i, (j) => (j === i ? k(j) : loop(j, count + 1, k)));
    };
    // an iteration that matches the empty string ends the loop
    return (i, k) => loop(i, 0, k);
  }
  assert(n) {
    switch (n.kind) {
      case 'bol': return (i, k) => i === 0 && k(i);
      case 'mbol': { const nl = n.nl; return (i, k) => (i === 0 || (i < SLEN && nlBefore(i, nl))) && k(i); }
      case 'eol': {
        const nl = n.nl;
        return (i, k) => (i === SLEN || (this.dollarEndOnly ? false : isNlAt(i, nl) && i + nlLen(i, nl) === SLEN)) && k(i);
      }
      case 'meol': { const nl = n.nl; return (i, k) => (i === SLEN || isNlAt(i, nl)) && k(i); }
      case 'start': return (i, k) => i === 0 && k(i);
      case 'end': return (i, k) => i === SLEN && k(i);
      case 'endnl': { const nl = n.nl; return (i, k) => (i === SLEN || (isNlAt(i, nl) && i + nlLen(i, nl) === SLEN)) && k(i); }
      case 'G': return (i, k) => i === startOff && k(i);
      case 'wordb': { const u = n.ucp; return (i, k) => wordAt(i - 1, u) !== wordAt(i, u) && k(i); }
      case 'nwordb': { const u = n.ucp; return (i, k) => wordAt(i - 1, u) === wordAt(i, u) && k(i); }
    }
    throw new Error('regex: unknown assertion');
  }
  cond(n) {
    const yes = this.c(n.yes), no = this.c(n.no), c = n.cond;
    switch (c.kind) {
      case 'set': { const nums = c.nums; return (i, k) => (nums.some((x) => caps[2 * x + 1] >= 0) ? yes(i, k) : no(i, k)); }
      case 'rec': {
        if (c.num === undefined) return (i, k) => (recStack.length > 0 ? yes(i, k) : no(i, k));
        const num = c.num;
        return (i, k) => (recStack.length > 0 && recStack[recStack.length - 1].num === num ? yes(i, k) : no(i, k));
      }
      case 'define': return (i, k) => k(i);
      case 'true': return yes;
      case 'assert': {
        const test = this.look(c.look);
        return (i, k) => {
          let passed = false;
          const r = test(i, () => { passed = true; return true; });
          void r;
          return passed ? yes(i, k) : no(i, k);
        };
      }
    }
    throw new Error('regex: unknown condition');
  }
  verb(n) {
    switch (n.v) {
      case 'FAIL': return () => false;
      case 'ACCEPT': return (i) => {
        // end the match (or the innermost recursion/assertion) here
        const top = acceptK.length ? acceptK[acceptK.length - 1] : null;
        const base = top ? top.groups : 0;
        for (let g = openGroups.length - 1; g >= base; g--) { const o = openGroups[g]; caps[2 * o.cap] = o.start; caps[2 * o.cap + 1] = i; }
        return top ? top.k(i) : this.final(i);
      };
      case 'MARK': { const name = n.arg; return (i, k) => { const old = mark; mark = name; if (k(i)) return true; mark = old; return false; }; }
      case 'COMMIT': return (i, k) => { if (n.arg !== null) mark = n.arg; if (k(i)) return true; if (!verb) verb = V_COMMIT; return false; };
      case 'PRUNE': return (i, k) => { if (n.arg !== null) mark = n.arg; if (k(i)) return true; if (!verb) verb = V_PRUNE; return false; };
      case 'SKIP': return (i, k) => { if (k(i)) return true; if (!verb) { verb = V_SKIP; skipTo = i; } return false; };
      case 'THEN': {
        const id = this.altStack.length ? this.altStack[this.altStack.length - 1] : -1;
        return (i, k) => { if (n.arg !== null) mark = n.arg; if (k(i)) return true; if (!verb) { verb = id < 0 ? V_PRUNE : V_THEN; thenAlt = id; } return false; };
      }
    }
    throw new Error('regex: unknown verb');
  }
}

// ------------------------------------------------------------------ public API
export class Regex {
  constructor(P, root, opts) {
    this.ncap = P.ncap;
    this.names = P.names; // [{ name, num }] in pattern order
    this.utf = P.utf;
    const C = new RegexCompiler(P, P.utf);
    C.dollarEndOnly = !!opts.dollarEndOnly;
    this.C = C;
    C.final = (i) => this.finalK(i);
    C.root = C.c(root);
    this.m = C.root;
    this.anchored = !!opts.anchored || startsAnchored(root);
    this.firstChar = firstCharOf(root);
    this.firstSet = this.firstChar === null ? firstSetOf(root) : null;
    this.reqChar = P.hasAccept ? null : requiredCharOf(root);
    this.complex = true;
    this.finalBound = (j) => this.finalK(j);
    this.notEmptyOpt = P.notEmpty;
    this.wantUtf = !!P.wantUtf;
    this.noJit = !!P.noJit;
    this.ucp = !!P.ucp;
    // byte-mode patterns whose semantics JS RegExp reproduces exactly run on V8's engine
    this.fast = null;
    if (!P.utf && !P.hasBranchReset && !P.notEmpty) {
      const src = jsSource(root, !!opts.dollarEndOnly);
      if (src !== null) {
        try {
          const flags = this.ncap > 0 ? 'gd' : 'g';
          this.fast = { re: new RegExp(src, flags), sticky: new RegExp(src, flags.replace('g', 'y')), src };
        } catch (e) { this.fast = null; }
      }
    }
  }
  // exec() for byte strings, with the JS RegExp fast path when there is one
  execStr(str, units, start, o, allowFast) {
    const f = this.fast;
    if (f === null || !allowFast || o.notEmptyAtStart) return this.exec(units(), start, o);
    const re = this.anchored || o.anchored ? f.sticky : f.re;
    re.lastIndex = start;
    const m = re.exec(str);
    if (m === null) return null;
    const caps = this.capsBuf || (this.capsBuf = new Int32Array(2 * (this.ncap + 1)));
    if (this.ncap > 0) caps.fill(-1);
    caps[0] = m.index; caps[1] = m.index + m[0].length;
    if (this.ncap > 0) {
      const ind = m.indices;
      for (let g = 1; g <= this.ncap; g++) { const x = ind[g]; if (x !== undefined) { caps[2 * g] = x[0]; caps[2 * g + 1] = x[1]; } }
    }
    return { start: caps[0], end: caps[1], caps, mark: null };
  }
  // the result's caps array is reused by the next exec of this regex
  finalK(j) {
    if (notEmpty && j === matchStart) return false;
    if (notEmptyAtStart && j === startOff && matchStart === startOff) return false;
    this.end = j;
    return true;
  }
  // match at or after `start`; returns { start, end, caps (Int32Array, -1 for unset), mark } or null
  exec(units, start, o = {}) {
    SUBJ = units; SLEN = units.length;
    stepLimit = o.backtrackLimit || 1000000; depthLimit = o.recursionLimit || 100000;
    steps = 0; jitMode = !!o.jit && !this.noJit;
    notEmptyAtStart = !!o.notEmptyAtStart || this.notEmptyOpt === 'NOTEMPTY_ATSTART';
    notEmpty = this.notEmptyOpt === 'NOTEMPTY';
    startOff = start;
    const anchored = this.anchored || !!o.anchored;
    caps = this.capsBuf || (this.capsBuf = new Int32Array(2 * (this.ncap + 1)));
    caps.fill(-1);
    const final = this.finalBound;
    const fc = this.firstChar, fs = this.firstSet;
    if (this.reqChar !== null && this.reqChar !== fc) {
      let found = false;
      for (let x = start; x < SLEN; x++) if (SUBJ[x] === this.reqChar) { found = true; break; }
      if (!found) return null;
    }
    let dirty = true;
    for (let s = start; s <= SLEN; s++) {
      if (!anchored) {
        if (fc !== null) { while (s < SLEN && SUBJ[s] !== fc) s++; if (s >= SLEN) break; }
        else if (fs !== null) { while (s < SLEN && !fs(SUBJ[s])) s++; if (s >= SLEN) break; }
      }
      if (dirty) { caps.fill(-1); recStack.length = 0; acceptK.length = 0; openGroups.length = 0; }
      dirty = this.ncap > 0 || this.complex;
      matchStart = s; mark = null; verb = 0; skipTo = -1; depth = 1; jitStack = 0;
      reTick();
      if (this.m(s, final)) {
        caps[0] = matchStart; caps[1] = this.end;
        return { start: matchStart, end: this.end, caps, mark };
      }
      if (anchored || verb === V_COMMIT) break;
      if (verb === V_SKIP && skipTo > s) s = skipTo - 1;
    }
    return null;
  }
}
// ------------------------------------------------------------------ JS RegExp fast path
// The source of a JS RegExp (no flags; matched against a byte string) with exactly the same
// matches and captures as the node, or null. Excluded: what JS doesn't have (atomic groups,
// recursion, verbs, ...), backreferences (JS matches an unset group as empty), quantified
// groups containing captures or able to match empty (JS resets those captures and rejects
// empty iterations), and nested quantifiers (JS has no backtrack limit).
const hex2 = (c) => '\\x' + c.toString(16).padStart(2, '0');
function jsChar(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? String.fromCharCode(c) : hex2(c); }
function jsSet(test) {
  let out = '', n = 0;
  for (let x = 0; x < 256;) {
    if (!test(x)) { x++; continue; }
    let y = x;
    while (y + 1 < 256 && test(y + 1)) y++;
    out += y === x ? jsChar(x) : y === x + 1 ? jsChar(x) + jsChar(y) : jsChar(x) + '-' + jsChar(y);
    n += y - x + 1;
    x = y + 1;
  }
  if (n === 0) return '(?!)';
  if (n === 256) return '[\\s\\S]';
  return '[' + out + ']';
}
function hasCap(n) {
  if (!n || typeof n !== 'object') return false;
  if (n.t === 'group' && n.cap) return true;
  for (const k of ['body', 'yes', 'no']) if (n[k] && hasCap(n[k])) return true;
  for (const k of ['items', 'alts']) if (n[k] && n[k].some(hasCap)) return true;
  return false;
}
function hasLoop(n) {
  if (!n || typeof n !== 'object') return false;
  if ((n.t === 'rep' && n.max > 1) || n.t === 'alt') return true;
  if (n.body && hasLoop(n.body)) return true;
  for (const k of ['items', 'alts']) if (n[k] && n[k].some(hasLoop)) return true;
  return false;
}
function jsSource(n, dollarEndOnly) {
  const go = (x) => jsSource(x, dollarEndOnly);
  switch (n.t) {
    case 'empty': return '';
    case 'char': {
      if (n.c > 255) return null;
      if (!n.ci) return jsChar(n.c);
      const o = otherCases(n.c, false);
      return o.length ? '[' + jsChar(n.c) + o.map(jsChar).join('') + ']' : jsChar(n.c);
    }
    case 'any': return n.dotall ? '[\\s\\S]' : (!n.nl || n.nl === 'lf') ? '[^\\n]' : null;
    case 'set': return jsSet(n.test);
    case 'seq': { let out = ''; for (const it of n.items) { const x = go(it); if (x === null) return null; out += x; } return out; }
    case 'alt': { const xs = n.alts.map(go); return xs.includes(null) ? null : '(?:' + xs.join('|') + ')'; }
    case 'group': { const b = go(n.body); return b === null ? null : (n.cap ? '(' : '(?:') + b + ')'; }
    case 'rep': {
      if (n.possessive || canBeEmpty(n.body)) return null;
      if (n.max > 1 && (hasCap(n.body) || hasLoop(n.body))) return null;
      const b = go(n.body);
      if (b === null) return null;
      const q = n.min === 0 && n.max === Infinity ? '*' : n.min === 1 && n.max === Infinity ? '+' : n.min === 0 && n.max === 1 ? '?'
        : n.max === Infinity ? `{${n.min},}` : n.min === n.max ? `{${n.min}}` : `{${n.min},${n.max}}`;
      const atom = n.body.t === 'group' || n.body.t === 'set' || n.body.t === 'any' || (n.body.t === 'char' && !b.startsWith('[') ? b.length <= 4 : n.body.t === 'char') ? b : '(?:' + b + ')';
      return atom + q + (n.greedy ? '' : '?');
    }
    case 'assert': {
      if (n.nl && n.nl !== 'lf') return null;
      switch (n.kind) {
        case 'bol': case 'start': return '^';
        case 'mbol': return '(?:^|(?<=\\n)(?=[\\s\\S]))';
        case 'eol': return dollarEndOnly ? '(?![\\s\\S])' : '(?=\\n?(?![\\s\\S]))';
        case 'endnl': return '(?=\\n?(?![\\s\\S]))';
        case 'meol': return '(?=\\n|(?![\\s\\S]))';
        case 'end': return '(?![\\s\\S])';
        case 'wordb': return n.ucp ? null : '\\b';
        case 'nwordb': return n.ucp ? null : '\\B';
      }
      return null;
    }
    case 'look': {
      if (n.behind && hasCap(n.body)) return null;
      const b = go(n.body);
      if (b === null) return null;
      return '(?' + (n.behind ? '<' : '') + (n.neg ? '!' : '=') + b + ')';
    }
  }
  return null;
}

function startsAnchored(n) {
  switch (n.t) {
    case 'assert': return n.kind === 'start' || n.kind === 'bol';
    case 'seq': return n.items.length > 0 && startsAnchored(n.items[0]);
    case 'alt': return n.alts.every(startsAnchored);
    case 'group': case 'atomic': return startsAnchored(n.body);
  }
  return false;
}
// a test every match's first code unit passes (a match can't be empty), or null
function firstSetOf(n) {
  switch (n.t) {
    case 'char': {
      if (!n.ci) { const c = n.c; return (x) => x === c; }
      const c = n.c, o = otherCases(c, true).concat(otherCases(c, false));
      return (x) => x === c || o.includes(x);
    }
    case 'set': return n.test;
    case 'seq': {
      for (const it of n.items) {
        if (it.t === 'verb' && it.v === 'MARK') continue;
        return firstSetOf(it);
      }
      return null;
    }
    case 'group': case 'atomic': return firstSetOf(n.body);
    case 'rep': return n.min > 0 ? firstSetOf(n.body) : null;
    case 'alt': {
      const f = n.alts.map(firstSetOf);
      if (f.some((x) => x === null)) return null;
      return (x) => { for (const t of f) if (t(x)) return true; return false; };
    }
  }
  return null;
}
// a code unit every match contains (PCRE2's "last required code unit"), or null
function requiredCharOf(n) {
  switch (n.t) {
    case 'char': return n.ci ? null : n.c;
    case 'seq': {
      let r = null;
      for (const it of n.items) { const x = requiredCharOf(it); if (x !== null) r = x; }
      return r;
    }
    case 'group': case 'atomic': return requiredCharOf(n.body);
    case 'rep': return n.min > 0 ? requiredCharOf(n.body) : null;
    case 'alt': { const f = n.alts.map(requiredCharOf); return f.every((x) => x !== null && x === f[0]) ? f[0] : null; }
  }
  return null;
}
// the code unit every match must start with, or null
function firstCharOf(n) {
  switch (n.t) {
    case 'char': return n.ci ? null : n.c;
    case 'seq': {
      for (const it of n.items) {
        if (it.t === 'verb' && it.v === 'MARK') continue;
        return firstCharOf(it);
      }
      return null;
    }
    case 'group': case 'atomic': return firstCharOf(n.body);
    case 'rep': return n.min > 0 ? firstCharOf(n.body) : null;
    case 'alt': { const f = n.alts.map(firstCharOf); return f.every((x) => x !== null && x === f[0]) ? f[0] : null; }
  }
  return null;
}

// Compile a pattern: `pattern` is an array of code points (code units of the pattern string,
// decoded from UTF-8 in UTF mode) and `offs` their byte offsets (for error messages).
export function compileRegex(pattern, offs, opts) {
  let o = 0;
  if (opts.caseless) o |= O_I;
  if (opts.multiline) o |= O_M;
  if (opts.dotall) o |= O_S;
  if (opts.extended) o |= O_X;
  if (opts.ungreedy) o |= O_U;
  if (opts.noAutoCapture) o |= O_N;
  if (opts.dupnames) o |= O_J;
  const P = new RegexParser(pattern, offs, opts);
  const root = P.parse(o);
  P.root = root;
  // resolve references to groups
  for (const r of P.refs) {
    if (r.name !== undefined) {
      const nums = P.names.filter((x) => x.name === r.name).map((x) => x.num);
      if (!nums.length) throw new RegexSyntaxError('reference to non-existent subpattern', P.off(r.at));
      if (r.t === 'call' || r.kind === 'rec') r.num = nums[0]; else r.nums = nums;
    } else if (r.num !== undefined) {
      if (r.num > P.ncap) throw new RegexSyntaxError('reference to non-existent subpattern', P.off(r.at));
      if (r.t === 'backref' || r.kind === 'set') r.nums = [r.num];
    }
  }
  for (const lb of P.lookbehinds) {
    const alts = lb.body.t === 'alt' ? lb.body.alts : [lb.body];
    for (const a of alts) if (fixedLength(a, P) < 0) throw new RegexSyntaxError('lookbehind assertion is not fixed length', P.off(lb.at));
  }
  void canBeEmpty;
  return new Regex(P, root, opts);
}
