// Parser: tokens -> AST (recursive descent for statements, Pratt parsing for expressions).

import pathMod from 'node:path';
import { I64MIN, mkf, ParseErr } from './values.js';
import { neg } from './arith.js';
import { lex } from './lexer.js';

const BIN_BP = {
  'or': [1, 'L'], 'xor': [2, 'L'], 'and': [3, 'L'],
  '??': [8, 'R'], '||': [9, 'L'], '&&': [10, 'L'],
  '|': [11, 'L'], '^': [12, 'L'], '&': [13, 'L'],
  '==': [14, 'N'], '!=': [14, 'N'], '===': [14, 'N'], '!==': [14, 'N'], '<>': [14, 'N'], '<=>': [14, 'N'],
  '<': [15, 'N'], '<=': [15, 'N'], '>': [15, 'N'], '>=': [15, 'N'],
  '.': [16, 'L'], '<<': [17, 'L'], '>>': [17, 'L'],
  '+': [18, 'L'], '-': [18, 'L'], '*': [19, 'L'], '/': [19, 'L'], '%': [19, 'L'],
  'instanceof': [21, 'L'], '**': [22, 'R'],
};
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '.=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '??=']);
// names a class can't have (zend_is_reserved_class_name)
export const RESERVED_CLASS_NAMES = new Set(['bool', 'false', 'float', 'int', 'null', 'parent', 'self', 'static', 'string', 'true', 'void', 'never', 'iterable', 'object', 'mixed']);
const RESERVED_TYPES = new Set(['int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'null', 'never', 'false', 'true', 'self', 'parent', 'static']);
const MAGIC = new Set(['__line__', '__file__', '__dir__', '__function__', '__class__', '__method__', '__namespace__', '__trait__']);
// statements PHP doesn't tick after (zend_is_unticked_stmt, plus if and switch which don't in practice)
const UNTICKED = new Set(['Block', 'Label', 'FuncDecl', 'ClassDecl', 'If', 'Switch']);
// keywords that can't be goto labels where a statement starts
const LABEL_RESERVED = new Set(['default', 'case', 'else', 'endif', 'endwhile', 'endfor', 'endforeach', 'endswitch', 'enddeclare']);

export const LVAL_KINDS = new Set(['Var', 'VarVar', 'Index', 'Prop', 'SProp', 'List']);
const CALL_TARGETS = new Set(['Call', 'MCall', 'NullsafeMCall', 'SCall']);

export class Parser {
  constructor(toks, file, shared) {
    this.toks = toks; this.p = 0; this.file = file;
    this.st = shared || { ns: '', uses: new Map(), useFns: new Map(), useConsts: new Map(), fnStack: [], clsStack: [], anonCount: 0, strict: false };
  }
  get tok() { const t = this.toks[this.p]; if (t.t === 'error') throw new ParseErr(t.v, t.l); return t; }
  peek(o = 1) { return this.toks[this.p + o] || this.toks[this.toks.length - 1]; }
  next() { return this.toks[this.p++]; }
  error(msg, tk) { tk = tk || this.tok; throw new ParseErr(msg, tk.l); }
  // a compile error PHP reports while parsing ("Fatal error", not "Parse error")
  fatal(msg, tk) { tk = tk || this.tok; throw new ParseErr(msg, tk.l, 'Fatal error'); }
  // the pending doc comment at token tk, if no declaration has taken it yet (see the lexer)
  takeDoc(tk) { const d = tk && tk.doc; if (!d || d.used) return null; d.used = true; return d.text; }
  // #[Name(args), ...] groups: [{ name, args, l }]
  parseAttributes() {
    let attrs = null;
    while (this.isOp('#[')) {
      this.p++;
      while (!this.isOp(']')) {
        const l = this.tok.l;
        const name = this.resolveClass(this.ident());
        const args = this.isOp('(') ? this.parseArgs() : [];
        (attrs || (attrs = [])).push({ name, args, l });
        if (!this.accept(',')) break;
      }
      this.expect(']');
    }
    return attrs;
  }
  // "syntax error, unexpected <token>" with the token described as PHP's grammar names it
  unexpected(tk, expecting) {
    tk = tk || this.tok;
    let d;
    switch (tk.t) {
      case 'eof': d = 'end of file'; break;
      case 'var': d = `variable "$${tk.v}"`; break;
      case 'id': {
        const v = tk.v;
        if (v[0] === '\\') d = `fully qualified name "${v}"`;
        else if (/^namespace\\/i.test(v)) d = `namespace-relative name "${v}"`;
        else if (v.includes('\\')) d = `namespaced name "${v}"`;
        else d = PHP_KEYWORDS.has(v.toLowerCase()) ? `token "${v}"` : `identifier "${v}"`;
        break;
      }
      case 'str': d = tk.heredoc ? `heredoc start "${tk.heredoc}"` : `${tk.sq ? 'single' : 'double'}-quoted string "${tk.v}"`; break;
      case 'tpl': d = tk.heredoc ? `heredoc start "${tk.heredoc}"` : 'double-quote mark'; break;
      case 'shell': d = 'token "`"'; break;
      case 'cast': d = `token "(${tk.v})"`; break;
      case 'int': d = `integer "${tk.raw ?? tk.v}"`; break;
      case 'float': d = `floating-point number "${tk.raw ?? tk.v}"`; break;
      default: d = `token "${tk.v}"`;
    }
    // (expecting: what PHP's grammar lists where only a few tokens may follow)
    this.error(`syntax error, unexpected ${d}${expecting ? ', expecting ' + expecting : ''}`, tk.heredoc ? { l: tk.l + 1 } : tk);
  }
  isOp(v, o = 0) { const t = this.toks[this.p + o]; return t && t.t === 'op' && t.v === v; }
  isId(v, o = 0) { const t = this.toks[this.p + o]; return t && t.t === 'id' && t.v.toLowerCase() === v; }
  accept(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  acceptId(v) { if (this.isId(v)) { this.p++; return true; } return false; }
  expect(v) { if (!this.isOp(v)) this.unexpected(); return this.next(); }
  expectId(v) { if (!this.isId(v)) this.unexpected(); return this.next(); }
  ident() { const t = this.tok; if (t.t !== 'id') this.unexpected(); this.p++; return t.v; }
  semi() { if (this.accept(';')) return; if (this.tok.t === 'eof') return; this.unexpected(); }

  // ---------------------------------------------------------------- names
  resolveClass(name) {
    const ln = name.toLowerCase();
    if (name[0] === '\\') return name.slice(1);
    if (ln === 'self' || ln === 'parent' || ln === 'static') return ln;
    if (ln.startsWith('namespace\\')) return (this.st.ns ? this.st.ns + '\\' : '') + name.slice(10);
    const bs = name.indexOf('\\');
    const first = (bs < 0 ? name : name.slice(0, bs)).toLowerCase();
    if (this.st.uses.has(first)) return this.st.uses.get(first) + (bs < 0 ? '' : name.slice(bs));
    return this.st.ns ? this.st.ns + '\\' + name : name;
  }
  resolveFn(name) { // returns [name, fallback]
    if (name[0] === '\\') return [name.slice(1), null];
    const ln = name.toLowerCase();
    if (ln.startsWith('namespace\\')) return [(this.st.ns ? this.st.ns + '\\' : '') + name.slice(10), null];
    if (name.includes('\\')) return [this.resolveClass(name), null];
    if (this.st.useFns.has(ln)) return [this.st.useFns.get(ln), null];
    if (this.st.ns) return [this.st.ns + '\\' + name, name];
    return [name, null];
  }
  resolveConst(name) {
    if (name[0] === '\\') return [name.slice(1), null];
    if (name.includes('\\')) return [this.resolveClass(name), null];
    if (this.st.useConsts.has(name)) return [this.st.useConsts.get(name), null];
    if (this.st.ns) return [this.st.ns + '\\' + name, name];
    return [name, null];
  }
  // a class named by extends/implements/use: self, parent and static can't be (zend_resolve_const_class_name_reference)
  classRefName(kind, name) {
    const tk = this.tok;
    if (name === undefined) name = this.ident();
    if (/^(self|parent|static)$/i.test(name)) this.fatal(`Cannot use '${name}' as ${kind} name, as it is reserved`, tk);
    return this.resolveClass(name);
  }
  nsName(name) { return this.st.ns ? this.st.ns + '\\' + name : name; }

  // ---------------------------------------------------------------- program
  parseProgram() {
    const body = [];
    while (this.tok.t !== 'eof') {
      const s = this.parseStatement(true);
      if (s) {
        if (this.st.nsMode === 'braced' && !(s.k === 'Block' && s.top) && s.k !== 'Nop') throw new ParseErr('No code may exist outside of namespace {}', s.l, 'Fatal error');
        body.push(s);
        if (s.k !== 'Nop') this.st.topStmts = (this.st.topStmts || 0) + 1;
      }
    }
    return body;
  }

  parseBlockOrStatement() {
    if (this.isOp('{')) return this.parseBlock();
    const l = this.tok.l;
    return this.parseStatement() || { k: 'Block', body: [], l };
  }
  parseBlock() {
    const l = this.expect('{').l;
    const body = [];
    while (!this.isOp('}')) {
      if (this.tok.t === 'eof') this.unexpected();
      const s = this.parseStatement(); if (s) body.push(s);
    }
    this.p++;
    return { k: 'Block', body, l };
  }
  parseStmtsUntil(...ends) {
    const body = [];
    while (!ends.some((e) => this.isId(e))) {
      if (this.tok.t === 'eof') this.unexpected();
      const s = this.parseStatement(); if (s) body.push(s);
    }
    return { k: 'Block', body, l: this.tok.l };
  }

  // declare(ticks=N): every statement that PHP ticks after gets `ticks` (see cStmt)
  parseStatement(top) {
    if (!this.isId('declare') && !(this.tok.t === 'op' && this.tok.v === ';')) this.sawStatement = true; // for strict_types placement
    const st = this.parseStatement0(top);
    if (st && this.st.ticks && !UNTICKED.has(st.k)) st.ticks = this.st.ticks;
    return st;
  }
  parseStatement0(top) {
    if (this.isOp('#[')) {
      const attrs = this.parseAttributes();
      const st = this.parseStatement(top);
      if (st && st.k === 'FuncDecl') st.fn.attrs = attrs;
      else if (st && st.k === 'ClassDecl') st.attrs = attrs;
      else if (st && st.k === 'ExprStmt' && st.e.k === 'Closure') st.e.fn.attrs = attrs;
      return st;
    }
    const t = this.tok, l = t.l;
    if (t.t === 'html') { this.p++; return { k: 'Echo', args: [{ k: 'Lit', v: t.v, l }], l }; }
    if (t.t === 'op') {
      if (t.v === '{') return this.parseBlock();
      if (t.v === ';') { this.p++; return null; }
    }
    if (t.t === 'id') {
      const kw = t.v.toLowerCase();
      const nx = this.peek();
      // goto label: "name:" at the start of a statement
      if (nx.t === 'op' && nx.v === ':' && !LABEL_RESERVED.has(kw)) { this.p += 2; return { k: 'Label', name: t.v, l }; }
      switch (kw) {
        case 'echo': {
          this.p++;
          const args = [this.parseExpr()];
          while (this.accept(',')) args.push(this.parseExpr());
          this.semi();
          return { k: 'Echo', args, l };
        }
        case 'if': return this.parseIf();
        case 'while': {
          this.p++; this.expect('('); const c = this.parseExpr(); this.expect(')');
          let body;
          if (this.accept(':')) { body = this.parseStmtsUntil('endwhile'); this.p++; this.semi(); }
          else body = this.parseBlockOrStatement();
          return { k: 'While', c, body, l };
        }
        case 'do': {
          this.p++; const body = this.parseBlockOrStatement();
          this.expectId('while'); this.expect('('); const c = this.parseExpr(); this.expect(')'); this.semi();
          return { k: 'DoWhile', c, body, l };
        }
        case 'for': {
          this.p++; this.expect('(');
          const list = (end) => { const r = []; if (!this.isOp(end)) { r.push(this.parseExpr()); while (this.accept(',')) r.push(this.parseExpr()); } this.expect(end); return r; };
          const init = list(';'), cond = list(';'), step = list(')');
          let body;
          if (this.accept(':')) { body = this.parseStmtsUntil('endfor'); this.p++; this.semi(); }
          else body = this.parseBlockOrStatement();
          return { k: 'For', init, cond, step, body, l };
        }
        case 'foreach': {
          this.p++; this.expect('(');
          const e = this.parseExpr();
          this.expectId('as');
          let k = null, v, byRef = false;
          let first, firstRef = false;
          if (this.accept('&')) firstRef = true;
          first = this.parseExpr();
          if (this.accept('=>')) {
            if (firstRef) throw new ParseErr('Key element cannot be a reference', this.tok.l, 'Fatal error');
            k = first;
            if (this.accept('&')) byRef = true;
            v = this.parseExpr();
          } else { v = first; byRef = firstRef; }
          this.expect(')');
          if (v.k === 'Arr') v = this.toList(v);
          let body;
          if (this.accept(':')) { body = this.parseStmtsUntil('endforeach'); this.p++; this.semi(); }
          else body = this.parseBlockOrStatement();
          return { k: 'Foreach', e, kv: k, v, byRef, body, l };
        }
        case 'switch': {
          this.p++; this.expect('('); const e = this.parseExpr(); this.expect(')');
          const alt = !this.isOp('{');
          if (alt) this.expect(':'); else this.expect('{');
          this.accept(';');
          const cases = [];
          while (!(alt ? this.isId('endswitch') : this.isOp('}'))) {
            let test = null;
            const cl = this.tok.l;
            if (this.acceptId('case')) test = this.parseExpr();
            else if (!this.acceptId('default')) this.unexpected();
            if (!this.accept(':') && !this.accept(';')) this.unexpected();
            const body = [];
            while (!this.isId('case') && !this.isId('default') && !this.isOp('}') && !this.isId('endswitch')) {
              if (this.tok.t === 'eof') this.unexpected();
              const s = this.parseStatement(); if (s) body.push(s);
            }
            cases.push({ test, body, l: cl });
          }
          this.p++;
          if (alt) this.semi();
          return { k: 'Switch', e, cases, l };
        }
        case 'break': case 'continue': {
          this.p++;
          let n = 1;
          if (this.tok.t === 'int') {
            n = this.next().v;
            if (n < 1) this.fatal(`'${kw}' operator accepts only positive integers`);
          } else if (!this.isOp(';') && this.tok.t !== 'eof') this.fatal(`'${kw}' operator with non-integer operand is no longer supported`);
          this.semi();
          return { k: kw === 'break' ? 'Break' : 'Continue', n, l };
        }
        case 'return': {
          this.p++;
          let e = null;
          if (!this.isOp(';') && this.tok.t !== 'eof') e = this.parseExpr();
          this.semi();
          return { k: 'Return', e, l };
        }
        case 'function':
          if ((nx.t === 'id') || (nx.t === 'op' && nx.v === '&' && this.peek(2).t === 'id')) {
            this.p++;
            const byRef = this.accept('&');
            const doc = this.takeDoc(this.tok);
            const name = this.ident();
            this.declareSymbol('function', name);
            const fn = this.parseFunctionRest(this.nsName(name), byRef, l);
            fn.doc = doc;
            return { k: 'FuncDecl', fn, l, top: !!top };
          }
          break;
        case 'abstract': case 'final': case 'class': case 'readonly':
          if (kw === 'class' && nx.t === 'id') return this.parseClass();
          if (kw !== 'class' && (nx.t === 'id')) {
            const nl = nx.v.toLowerCase();
            if (['abstract', 'final', 'class', 'readonly'].includes(nl)) return this.parseClass();
          }
          break;
        case 'interface': if (nx.t === 'id') return this.parseClass(); break;
        case 'trait': if (nx.t === 'id') return this.parseClass(); break;
        case 'enum': if (nx.t === 'id' && !(this.peek(2).t === 'op' && ['(', '=', '::'].includes(this.peek(2).v))) return this.parseClass(); break;
        case 'try': return this.parseTry();
        case 'global': {
          this.p++;
          const names = [];
          do {
            const v = this.tok;
            if (v.t === 'var') { this.p++; names.push(v.v); }
            else if (this.isOp('$')) names.push(this.parsePrimaryVarOnly());
            else this.unexpected();
          } while (this.accept(','));
          this.semi();
          return { k: 'Global', names, l };
        }
        case 'static':
          if (nx.t === 'var') {
            this.p++;
            const vars = [];
            do {
              const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
              let init = null; if (this.accept('=')) init = this.parseExpr();
              vars.push({ name: v.v, init });
            } while (this.accept(','));
            this.semi();
            return { k: 'StaticVar', vars, l };
          }
          break;
        case 'unset': {
          if (!(nx.t === 'op' && nx.v === '(')) break;
          this.p++; this.expect('(');
          const list = [];
          if (!this.isOp(')')) { list.push(this.parseExpr()); while (this.accept(',')) { if (this.isOp(')')) break; list.push(this.parseExpr()); } }
          this.expect(')'); this.semi();
          return { k: 'Unset', list, l };
        }
        case 'namespace': {
          if (nx.t === 'op' && nx.v === '\\') break;
          if (nx.t === 'id' && nx.v.toLowerCase().startsWith('namespace\\')) break;
          if (!this.st.nsMode && this.st.topStmts) this.fatal('Namespace declaration statement has to be the very first statement or after any declare call in the script');
          this.p++;
          let name = '';
          if (this.tok.t === 'id') name = this.next().v;
          const mode = this.isOp('{') ? 'braced' : 'simple';
          if (this.st.nsMode && this.st.nsMode !== mode) this.fatal('Cannot mix bracketed namespace declarations with unbracketed namespace declarations');
          if (this.st.inNsBlock) this.fatal('Namespace declarations cannot be nested');
          if (name.toLowerCase() === 'namespace') this.fatal(`Cannot use '${name}' as namespace name`);
          this.st.ns = name; this.st.uses = new Map(); this.st.useFns = new Map(); this.st.useConsts = new Map();
          this.st.nsMode = mode;
          if (this.isOp('{')) {
            this.st.inNsBlock = true;
            let b;
            try { b = this.parseBlock(); } finally { this.st.inNsBlock = false; }
            b.top = true;
            return b;
          }
          this.semi();
          return null;
        }
        case 'use': {
          this.p++;
          let kind = 'class';
          if (this.isId('function')) { this.p++; kind = 'function'; } else if (this.isId('const')) { this.p++; kind = 'const'; }
          do {
            let name = this.ident();
            if (name[0] === '\\') name = name.slice(1);
            if (this.isOp('\\') || this.isOp('{') || name.endsWith('\\')) { // group use
              this.accept('\\');
              const prefix = name.replace(/\\$/, '');
              this.expect('{');
              const startExpect = kind === 'class' ? 'identifier or namespaced name or "function" or "const"' : 'identifier or namespaced name';
              let first = true;
              do {
                if (this.isOp('}')) { if (first) this.unexpected(this.tok, startExpect); break; }
                if (this.isOp(',') || (this.tok.t === 'id' && this.tok.v[0] === '\\')) this.unexpected(this.tok, first ? startExpect : '"}"');
                let k2 = kind;
                if (kind === 'class') { if (this.isId('function')) { this.p++; k2 = 'function'; } else if (this.isId('const')) { this.p++; k2 = 'const'; } }
                else if (this.isId('function') || this.isId('const')) this.unexpected(this.tok, first ? startExpect : '"}"');
                first = false;
                const sub = this.ident();
                let alias = sub.split('\\').pop();
                if (this.acceptId('as')) alias = this.ident();
                this.addUse(k2, prefix + '\\' + sub, alias);
              } while (this.accept(','));
              if (!this.isOp('}')) this.unexpected(this.tok, '"}"');
              this.p++;
            } else {
              let alias = name.split('\\').pop();
              if (this.acceptId('as')) alias = this.ident();
              else if (!name.includes('\\') && !this.st.ns) this.compileWarning(`The use statement with non-compound name '${name}' has no effect`);
              this.addUse(kind, name, alias);
            }
          } while (this.accept(','));
          this.semi();
          return null;
        }
        case 'const': {
          this.p++;
          const items = [];
          do { const name = this.ident(); this.declareSymbol('const', name); this.expect('='); items.push({ name: this.nsName(name), e: this.parseExpr() }); } while (this.accept(','));
          this.semi();
          return { k: 'ConstDecl', items, l };
        }
        case 'declare': {
          this.p++; this.expect('(');
          const prevTicks = this.st.ticks;
          let strict = false;
          do {
            const name = this.ident().toLowerCase(); this.expect('='); const e = this.parseExpr();
            if (name === 'ticks') { if (e.k !== 'Lit') throw new ParseErr('declare(ticks) value must be a literal', e.l, 'Fatal error'); this.st.ticks = Number(e.v); }
            if (name === 'strict_types') {
              if (e.k !== 'Lit' || (e.v !== 0 && e.v !== 1)) this.fatal('strict_types declaration must have 0 or 1 as its value', t);
              if (this.sawStatement) this.fatal('strict_types declaration must be the very first statement in the script', t);
              this.st.strict = e.v === 1;
              strict = true;
            }
          } while (this.accept(','));
          this.expect(')');
          if (strict && (this.isOp('{') || this.isOp(':'))) this.fatal('strict_types declaration must not use block mode', t);
          // block form: the declaration applies to the block only
          if (this.isOp('{')) { const b = this.parseBlock(); this.st.ticks = prevTicks; return b; }
          if (this.accept(':')) { const b = this.parseStmtsUntil('enddeclare'); this.p++; this.semi(); this.st.ticks = prevTicks; return b; }
          this.semi();
          return this.st.ticks ? { k: 'Nop', l } : null; // a declare statement ticks itself
        }
        case '__halt_compiler': {
          this.p = this.toks.length - 1;
          return null;
        }
        case 'goto': {
          this.p++;
          const label = this.ident();
          this.semi();
          return { k: 'Goto', label, l };
        }
      }
    }
    const e = this.parseExpr();
    this.semi();
    return { k: 'ExprStmt', e, l };
  }
  // imports (zend_compile_use): an alias can't name a symbol declared earlier in the file or be
  // imported twice; declarations can't reuse an imported name (declareSymbol)
  importsOf(kind) { return kind === 'function' ? this.st.useFns : kind === 'const' ? this.st.useConsts : this.st.uses; }
  seenSymbols(kind) {
    const seen = this.st.seen || (this.st.seen = { class: new Set(), function: new Set(), const: new Set() });
    return seen[kind];
  }
  addUse(kind, name, alias) {
    if (kind === 'class' && RESERVED_CLASS_NAMES.has(alias.toLowerCase())) this.fatal(`Cannot use ${name} as ${alias} because '${alias}' is a special class name`);
    const key = kind === 'const' ? alias : alias.toLowerCase();
    const what = kind === 'class' ? '' : ' ' + kind;
    const local = this.st.ns ? this.st.ns.toLowerCase() + '\\' + key : key;
    if (this.seenSymbols(kind).has(local) && name.toLowerCase() !== local.toLowerCase()) this.fatal(`Cannot use${what} ${name} as ${alias} because the name is already in use`);
    const imports = this.importsOf(kind);
    if (imports.has(key)) this.fatal(`Cannot use${what} ${name} as ${alias} because the name is already in use`);
    imports.set(key, name);
  }
  // a warning PHP raises while compiling (checkProgram() reports them)
  compileWarning(msg) { (this.st.compileWarnings || (this.st.compileWarnings = [])).push({ msg, l: this.tok.l }); }
  declareSymbol(kind, short) {
    if (kind === 'const' && /^(true|false|null)$/i.test(short)) this.fatal(`Cannot redeclare constant '${short}'`);
    const full = this.nsName(short);
    const imported = this.importsOf(kind).get(kind === 'const' ? short : short.toLowerCase());
    if (imported !== undefined && (kind === 'const' ? imported !== full : imported.toLowerCase() !== full.toLowerCase())) this.fatal(`Cannot declare ${kind} ${full} because the name is already in use`);
    this.seenSymbols(kind).add(kind === 'const' ? (this.st.ns ? this.st.ns.toLowerCase() + '\\' + short : short) : full.toLowerCase());
  }

  parseIf() {
    const l = this.next().l;
    this.expect('('); const c = this.parseExpr(); this.expect(')');
    if (this.accept(':')) {
      const then = this.parseStmtsUntil('elseif', 'else', 'endif');
      const elifs = []; let els = null;
      for (;;) {
        if (this.acceptId('elseif')) { this.expect('('); const c2 = this.parseExpr(); this.expect(')'); this.expect(':'); elifs.push({ c: c2, body: this.parseStmtsUntil('elseif', 'else', 'endif') }); continue; }
        if (this.acceptId('else')) {
          if (this.isId('if')) { this.p++; this.expect('('); const c2 = this.parseExpr(); this.expect(')'); this.expect(':'); elifs.push({ c: c2, body: this.parseStmtsUntil('elseif', 'else', 'endif') }); continue; }
          this.expect(':'); els = this.parseStmtsUntil('endif'); continue;
        }
        break;
      }
      this.expectId('endif'); this.semi();
      return { k: 'If', c, then, elifs, els, l };
    }
    const then = this.parseBlockOrStatement();
    const elifs = []; let els = null;
    for (;;) {
      if (this.isId('elseif')) { this.p++; this.expect('('); const c2 = this.parseExpr(); this.expect(')'); elifs.push({ c: c2, body: this.parseBlockOrStatement() }); continue; }
      if (this.isId('else')) {
        this.p++;
        if (this.isId('if')) { this.p++; this.expect('('); const c2 = this.parseExpr(); this.expect(')'); elifs.push({ c: c2, body: this.parseBlockOrStatement() }); continue; }
        els = this.parseBlockOrStatement();
      }
      break;
    }
    return { k: 'If', c, then, elifs, els, l };
  }

  parseTry() {
    const l = this.next().l;
    const body = this.parseBlock();
    const catches = []; let fin = null;
    while (this.isId('catch')) {
      const cl = this.next().l;
      this.expect('(');
      const types = [this.resolveClass(this.ident())];
      while (this.accept('|')) types.push(this.resolveClass(this.ident()));
      let v = null;
      if (this.tok.t === 'var') v = this.next().v;
      this.expect(')');
      catches.push({ types, v, body: this.parseBlock(), l: cl });
    }
    if (this.acceptId('finally')) fin = this.parseBlock();
    if (!catches.length && !fin) this.error('Cannot use try without catch or finally');
    return { k: 'Try', body, catches, fin, l };
  }

  // ---------------------------------------------------------------- types
  parseType() {
    const l = this.tok.l;
    if (this.accept('?')) { const t = this.parseSingleType(); return { alts: t === 'null' ? [] : [t], nullable: true, q: true, raw: [t], l }; }
    const alts = [];
    let inter = false;
    for (;;) {
      if (this.accept('(')) { // DNF group
        const g = [this.parseSingleType()];
        while (this.accept('&')) g.push(this.parseSingleType());
        this.expect(')');
        alts.push({ inter: g });
      } else alts.push(this.parseSingleType());
      if (this.isOp('|')) { this.p++; continue; }
      if (this.isOp('&') && !(this.peek().t === 'var' || (this.peek().t === 'op' && (this.peek().v === '...' || this.peek().v === '&')))) { this.p++; inter = true; continue; }
      break;
    }
    if (inter) return { alts: [{ inter: alts }], nullable: false, raw: alts, l };
    const nullable = alts.some((a) => a === 'null' || a === 'mixed');
    return { alts: alts.filter((a) => a !== 'null'), nullable, raw: alts, l };
  }
  parseSingleType() {
    const tk = this.tok;
    const name = this.ident();
    const ln = name.toLowerCase();
    if (RESERVED_TYPES.has(ln)) return ln;
    const last = ln.slice(ln.lastIndexOf('\\') + 1);
    if (ln.includes('\\') && RESERVED_TYPES.has(last) && last !== 'self' && last !== 'parent' && last !== 'static') this.fatal(`Type declaration '${last}' must be unqualified`, tk);
    const cls = this.resolveClass(name);
    // a bare name that looks like a builtin type (zend_is_confusable_type)
    if (ln in CONFUSABLE_TYPES && !this.st.uses.has(ln)) {
      const correct = CONFUSABLE_TYPES[ln], extra = this.st.ns ? ' or import the class with "use"' : '';
      this.compileWarning(correct ? `"${name}" will be interpreted as a class name. Did you mean "${correct}"? Write "\\${cls}"${extra} to suppress this warning`
        : `"${name}" is not a supported builtin type and will be interpreted as a class name. Write "\\${cls}"${extra} to suppress this warning`);
    }
    return cls;
  }
  atTypeStart() {
    const t = this.tok;
    if (t.t === 'op' && (t.v === '?' || t.v === '(')) return true;
    return t.t === 'id';
  }

  // ---------------------------------------------------------------- functions
  parseParams() {
    this.expect('(');
    const params = [];
    while (!this.isOp(')')) {
      const prm = { name: null, def: null, byRef: false, variadic: false, type: null, promote: null, readonly: false, attrs: this.parseAttributes() };
      for (;;) {
        if (this.isId('public') || this.isId('protected') || this.isId('private')) { if (prm.promoteKw) this.fatal('Multiple access type modifiers are not allowed'); prm.promote = this.next().v.toLowerCase(); prm.promoteKw = true; continue; }
        if (this.isId('readonly')) { this.p++; prm.readonly = true; if (!prm.promote) prm.promote = 'public'; continue; }
        if (this.isId('static') || this.isId('abstract') || this.isId('final')) this.fatal(`Cannot use the ${this.tok.v.toLowerCase()} modifier on a parameter`);
        break;
      }
      if (this.tok.t !== 'var' && !this.isOp('&') && !this.isOp('...')) prm.type = this.parseType();
      if (this.accept('&')) prm.byRef = true;
      if (this.accept('...')) prm.variadic = true;
      const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
      prm.name = v.v;
      if (this.accept('=')) prm.def = this.parseExpr();
      params.push(prm);
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return params;
  }
  parseFunctionRest(name, byRef, l, opts = {}) {
    const fn = { name, byRef, params: null, ret: null, body: null, isGen: false, l, file: this.file, strict: false, static: !!opts.static };
    if (opts.cls !== undefined) fn.cls = opts.cls;
    fn.params = this.parseParams();
    if (opts.closure && this.acceptId('use')) {
      this.expect('(');
      fn.uses = [];
      while (!this.isOp(')')) {
        const r = this.accept('&'); const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
        fn.uses.push({ name: v.v, byRef: r });
        if (!this.accept(',')) break;
      }
      this.expect(')');
    }
    if (this.accept(':')) fn.ret = this.parseType();
    if (this.isOp('{')) {
      this.st.fnStack.push(fn);
      const b = this.parseBlock();
      this.st.fnStack.pop();
      fn.body = b.body;
    } else { this.semi(); fn.body = null; }
    fn.endLine = this.toks[this.p - 1].l;
    fn.strict = this.st.strict;
    return fn;
  }

  // ---------------------------------------------------------------- classes
  parseClass(anonArgs, anonFlags) {
    const l = this.tok.l;
    const flags = anonFlags || { abstract: false, final: false, readonly: false };
    while (this.isId('abstract') || this.isId('final') || this.isId('readonly')) {
      const f = this.next().v.toLowerCase();
      if (flags[f]) this.fatal(`Multiple ${f} modifiers are not allowed`);
      flags[f] = true;
    }
    if (flags.abstract && flags.final) this.fatal('Cannot use the final modifier on an abstract class');
    const startLine = this.tok.l;
    const kind = this.ident().toLowerCase(); // class|interface|trait|enum
    let name;
    const doc = this.takeDoc(this.tok);
    if (anonArgs !== undefined) name = 'class@anonymous';
    else { const short = this.ident(); this.declareSymbol('class', short); name = this.nsName(short); }
    const cd = { k: 'ClassDecl', kind, name, parent: null, interfaces: [], flags, consts: [], props: [], methods: [], traits: [], cases: [], enumType: null, l, file: this.file, anon: anonArgs !== undefined, doc, startLine, endLine: 0, attrs: null };
    if (kind === 'enum' && this.accept(':')) cd.enumType = this.parseType();
    if (this.acceptId('extends')) {
      if (kind === 'interface') { do cd.interfaces.push(this.classRefName('interface')); while (this.accept(',')); }
      else cd.parent = this.classRefName('class');
    }
    if (this.acceptId('implements')) { do cd.interfaces.push(this.classRefName('interface')); while (this.accept(',')); }
    this.st.clsStack.push(cd);
    this.expect('{');
    while (!this.accept('}')) {
      if (this.tok.t === 'eof') this.unexpected();
      this.parseMember(cd);
    }
    cd.endLine = this.toks[this.p - 1].l;
    this.st.clsStack.pop();
    return cd;
  }
  parseMember(cd) {
    const attrs = this.parseAttributes();
    const l = this.tok.l;
    if (this.acceptId('use')) {
      const names = [this.classRefName('trait')];
      while (this.accept(',')) names.push(this.classRefName('trait'));
      const rules = [];
      if (this.accept('{')) {
        while (!this.accept('}')) {
          let tn = null, m = this.ident();
          if (this.accept('::')) { tn = this.classRefName('trait', m); m = this.ident(); }
          if (this.acceptId('insteadof')) {
            const ex = [this.classRefName('trait')]; while (this.accept(',')) ex.push(this.classRefName('trait'));
            rules.push({ kind: 'insteadof', trait: tn, method: m, excl: ex });
          } else {
            this.expectId('as');
            let vis = null, alias = null, final = false;
            if (this.isId('public') || this.isId('protected') || this.isId('private')) vis = this.next().v.toLowerCase();
            else if (this.isId('final')) { this.next(); final = true; }
            else if (this.isId('static') || this.isId('abstract')) this.fatal(`Cannot use "${this.next().v.toLowerCase()}" as method modifier in trait alias`);
            else if (this.isId('readonly')) this.fatal('Cannot use the readonly modifier on a method');
            if (this.tok.t === 'id') alias = this.ident();
            rules.push({ kind: 'as', trait: tn, method: m, vis, alias, final });
          }
          this.semi();
        }
      } else this.semi();
      cd.traits.push({ names, rules, l });
      return;
    }
    if (this.acceptId('case')) {
      const doc = this.takeDoc(this.tok);
      const name = this.ident();
      let e = null; if (this.accept('=')) e = this.parseExpr();
      this.semi();
      cd.cases.push({ name, e, l, attrs, doc, seq: cd.seq = (cd.seq || 0) + 1 });
      return;
    }
    const mods = { vis: null, static: false, abstract: false, final: false, readonly: cd.flags.readonly, var: false };
    const once = (key, word) => { if (mods[key] && (key !== 'readonly' || !cd.flags.readonly || mods.readonlyKw)) this.fatal(`Multiple ${word} modifiers are not allowed`); mods[key] = true; };
    for (;;) {
      if (this.isId('public') || this.isId('protected') || this.isId('private')) { if (mods.vis) this.fatal('Multiple access type modifiers are not allowed'); mods.vis = this.next().v.toLowerCase(); continue; }
      if (this.isId('static') && !this.isOp('::', 1)) { once('static', 'static'); this.p++; continue; }
      if (this.isId('abstract')) { once('abstract', 'abstract'); this.p++; continue; }
      if (this.isId('final')) { once('final', 'final'); this.p++; continue; }
      if (this.isId('readonly')) { once('readonly', 'readonly'); mods.readonlyKw = true; this.p++; continue; }
      if (this.isId('var')) { this.p++; mods.var = true; continue; }
      break;
    }
    if (mods.abstract && mods.final && this.isId('function')) this.fatal('Cannot use the final modifier on an abstract method');
    if (this.isId('const') && mods.readonlyKw) this.fatal('Cannot use the readonly modifier on a class constant');
    if (this.isId('function') && mods.readonlyKw) this.fatal('Cannot use the readonly modifier on a method');
    if (this.acceptId('const')) {
      // optional type (PHP 8.3)
      let type = null;
      if ((this.tok.t === 'id' && this.peek().t === 'id') || this.isOp('?') || this.isOp('(')) type = this.parseType();
      do {
        const doc = this.takeDoc(this.tok);
        const name = this.ident(); this.expect('=');
        cd.consts.push({ name, e: this.parseExpr(), vis: mods.vis || 'public', final: mods.final, l, type, attrs, doc, seq: cd.seq = (cd.seq || 0) + 1 });
      } while (this.accept(','));
      this.semi();
      return;
    }
    if (this.acceptId('function')) {
      const byRef = this.accept('&');
      const nameTok = this.tok; if (nameTok.t !== 'id') this.unexpected(); this.p++;
      const doc = this.takeDoc(nameTok);
      const fn = this.parseFunctionRest(nameTok.v, byRef, l, { cls: cd.name });
      fn.cls = cd.name; fn.attrs = attrs; fn.doc = doc;
      cd.methods.push({ fn, vis: mods.vis || 'public', static: mods.static, abstract: mods.abstract || cd.kind === 'interface', abstractKw: mods.abstract, final: mods.final, l, seq: cd.seq = (cd.seq || 0) + 1 });
      return;
    }
    // property
    if (mods.abstract) this.fatal('Cannot use the abstract modifier on a property');
    if (mods.final) this.fatal('Cannot use the final modifier on a property');
    let type = null;
    if (this.tok.t !== 'var') type = this.parseType();
    do {
      const v = this.tok; if (v.t !== 'var') this.unexpected(); this.p++;
      const doc = this.takeDoc(v);
      let def; let hasDef = false;
      if (this.accept('=')) { def = this.parseExpr(); hasDef = true; }
      cd.props.push({ name: v.v, def: hasDef ? def : null, hasDef, static: mods.static, vis: mods.vis || 'public', type, readonly: mods.readonly, l, attrs, doc, seq: cd.seq = (cd.seq || 0) + 1 });
    } while (this.accept(','));
    if (this.isOp('{')) this.error('Property hooks are not supported');
    this.semi();
  }

  // ---------------------------------------------------------------- expressions
  parseExpr(minBp = 0) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.tok;
      let op;
      if (t.t === 'op') op = t.v;
      else if (t.t === 'id') { op = t.v.toLowerCase(); if (!(op === 'or' || op === 'xor' || op === 'and' || op === 'instanceof')) break; }
      else break;
      if (ASSIGN_OPS.has(op)) {
        // a call is parsed as a target too, for the compile error ("Can't use function return value in write context")
        if (!LVAL_KINDS.has(left.k) && left.k !== 'Arr' && !CALL_TARGETS.has(left.k)) break;
        if (minBp > 5 && !(left.k === 'Var' || left.k === 'Index' || left.k === 'Prop' || left.k === 'SProp' || left.k === 'VarVar')) break;
        this.p++;
        const l = t.l;
        if (op === '=') {
          if (this.isOp('&')) {
            this.p++;
            const e = this.parseExpr(5);
            left = { k: 'AssignRef', t: left, e, l };
          } else {
            let target = left;
            if (target.k === 'Arr') target = this.toList(target);
            left = { k: 'Assign', t: target, e: this.parseExpr(5), l };
          }
        } else {
          if (left.k === 'Arr') this.unexpected(t);
          left = { k: 'AssignOp', op: op.slice(0, -1), t: left, e: this.parseExpr(5), l };
        }
        continue;
      }
      if (op === '?') {
        if (minBp > 7) break;
        this.p++;
        if (this.accept(':')) { const b = this.parseExpr(8); left = { k: 'Ternary', c: left, a: null, b, l: t.l }; continue; }
        const a = this.parseExpr(0);
        this.expect(':');
        const b = this.parseExpr(8);
        left = { k: 'Ternary', c: left, a, b, l: t.l };
        continue;
      }
      const info = BIN_BP[op];
      if (!info) break;
      const [bp, assoc] = info;
      if (bp < minBp) break;
      this.p++;
      if (op === 'instanceof') {
        let cls;
        if (this.tok.t === 'id') { cls = this.resolveClass(this.next().v); }
        else cls = this.parseUnary();
        left = { k: 'Instanceof', e: left, cls, l: t.l };
        continue;
      }
      const right = this.parseExpr(assoc === 'R' ? bp : bp + 1);
      if (op === '&&' || op === 'and') left = { k: 'And', a: left, b: right, l: t.l };
      else if (op === '||' || op === 'or') left = { k: 'Or', a: left, b: right, l: t.l };
      else if (op === 'xor') left = { k: 'Xor', a: left, b: right, l: t.l };
      else if (op === '??') left = { k: 'Coalesce', a: left, b: right, l: t.l };
      else left = { k: 'Bin', op: op === '<>' ? '!=' : op, a: left, b: right, l: t.l };
    }
    return left;
  }

  toList(arr) {
    const items = arr.items.map((it) => {
      if (!it) return null;
      let v = it.v;
      if (v.k === 'Arr') v = this.toList(v);
      return { key: it.key, v, byRef: it.byRef, spread: it.spread };
    });
    return { k: 'List', items, l: arr.l };
  }

  parseUnary() {
    const t = this.tok, l = t.l;
    if (t.t === 'op') {
      switch (t.v) {
        case '!': this.p++; return { k: 'Not', e: this.parseExpr(20), l };
        case '-': {
          this.p++;
          const nt = this.tok;
          if ((nt.t === 'int' || nt.t === 'float') && !(this.peek().t === 'op' && this.peek().v === '**')) {
            // negative literal (handles PHP_INT_MIN)
            this.p++;
            const v = nt.t === 'int' ? neg(nt.v) : mkf(-nt.v);
            if (nt.t === 'int' && typeof nt.v === 'bigint' && nt.v === 9223372036854775808n) return this.parsePostfix({ k: 'Lit', v: I64MIN, l });
            return this.parsePostfix({ k: 'Lit', v, l });
          }
          return { k: 'Neg', e: this.parseExpr(20), l };
        }
        case '+': this.p++; return { k: 'Plus', e: this.parseExpr(20), l };
        case '~': this.p++; return { k: 'BitNot', e: this.parseExpr(20), l };
        case '@': this.p++; return { k: 'Silence', e: this.parseExpr(20), l };
        case '++': this.p++; return { k: 'PreInc', e: this.parseUnary(), l };
        case '--': this.p++; return { k: 'PreDec', e: this.parseUnary(), l };
        case '&': this.error('syntax error, unexpected token "&"');
      }
    }
    if (t.t === 'cast') {
      if (t.v === 'unset') this.fatal('The (unset) cast is no longer supported');
      this.p++; return { k: 'Cast', t: t.v, e: this.parseExpr(20), l };
    }
    if (t.t === 'id') {
      const kw = t.v.toLowerCase();
      switch (kw) {
        case 'new': return this.parsePostfix(this.parseNew());
        case 'clone': this.p++; return { k: 'Clone', e: this.parseUnary(), l };
        case 'print': this.p++; return { k: 'Print', e: this.parseExpr(4), l };
        case 'yield': {
          this.p++;
          const fn = this.st.fnStack[this.st.fnStack.length - 1];
          if (fn) fn.isGen = true; else this.fatal('The "yield" expression can only be used inside a function');
          if (this.isOp(';') || this.isOp(')') || this.isOp(',') || this.isOp(']') || this.tok.t === 'eof') return { k: 'Yield', key: null, v: null, l };
          let v = this.parseExpr(4), key = null;
          if (this.accept('=>')) { key = v; v = this.parseExpr(4); }
          return { k: 'Yield', key, v, l };
        }
        case 'yield from': {
          this.p++;
          const fn = this.st.fnStack[this.st.fnStack.length - 1];
          if (fn) fn.isGen = true; else this.fatal('The "yield" expression can only be used inside a function');
          return { k: 'YieldFrom', e: this.parseExpr(4), l };
        }
        case 'throw': this.p++; return { k: 'Throw', e: this.parseExpr(0), l };
        case 'include': case 'include_once': case 'require': case 'require_once':
          this.p++; return { k: 'Include', kind: kw, e: this.parseExpr(4), l };
      }
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parseNew() {
    const l = this.next().l;
    let cls;
    const attrs = this.parseAttributes();
    // modifiers of an anonymous class: only readonly
    let k = this.p;
    while (this.toks[k].t === 'id' && /^(readonly|abstract|final)$/i.test(this.toks[k].v)) k++;
    const anonFlags = { abstract: false, final: false, readonly: false };
    if (k > this.p && this.toks[k].t === 'id' && this.toks[k].v.toLowerCase() === 'class') {
      while (this.p < k) {
        const tk = this.next(), m = tk.v.toLowerCase();
        if (m !== 'readonly') this.fatal(`Cannot use the ${m} modifier on an anonymous class`, tk);
        if (anonFlags.readonly) this.fatal('Multiple readonly modifiers are not allowed', tk);
        anonFlags.readonly = true;
      }
    }
    if (attrs && !this.isId('class')) this.unexpected();
    if (this.isId('class')) {
      // anonymous class
      this.p++;
      let args = [];
      if (this.isOp('(')) args = this.parseArgs();
      this.p--; // re-point at 'class' keyword for parseClass
      this.toks[this.p] = { t: 'id', v: 'class', l };
      const cd = this.parseClass(args, anonFlags);
      cd.attrs = attrs;
      cd.name = 'class@anonymous' + (++this.st.anonCount);
      return { k: 'New', cls: cd, args, l };
    }
    if (this.tok.t === 'id') {
      const name = this.next().v;
      cls = this.resolveClass(name);
    } else if (this.tok.t === 'var') {
      cls = { k: 'Var', name: this.next().v, l };
      // allow $obj->prop / $a['x'] / Foo::$x as class name expression
      for (;;) {
        if (this.isOp('->') || this.isOp('?->')) { const ns = this.next().v === '?->'; const nm = this.tok.t === 'id' ? this.next().v : this.parseExpr(); cls = { k: 'Prop', o: cls, name: nm, nullsafe: ns, l }; continue; }
        if (this.isOp('[')) { this.p++; const i = this.parseExpr(); this.expect(']'); cls = { k: 'Index', o: cls, i, l }; continue; }
        if (this.isOp('::') && this.peek().t === 'var') { this.p++; cls = { k: 'SProp', cls, name: this.next().v, l }; continue; }
        break;
      }
    } else if (this.accept('(')) {
      cls = this.parseExpr(); this.expect(')');
    } else if (this.isId('static')) { this.p++; cls = 'static'; }
    else this.unexpected();
    let args = [];
    if (this.isOp('(')) args = this.parseArgs();
    return { k: 'New', cls, args, l };
  }

  parseArgs() {
    this.expect('(');
    const args = [];
    if (this.isOp('...') && this.peek().t === 'op' && this.peek().v === ')') { this.p += 2; return 'fcc'; }
    while (!this.isOp(')')) {
      if (this.accept('...')) { args.push({ e: this.parseExpr(), spread: true }); }
      else if (this.tok.t === 'id' && this.isOp(':', 1) && !this.isOp('::', 1)) {
        const name = this.next().v; this.p++;
        args.push({ e: this.parseExpr(), name });
      } else args.push({ e: this.parseExpr() });
      if (!this.accept(',')) break;
      if (this.isOp(',')) this.unexpected(this.tok, '")"'); // f($a,,$b)
    }
    this.expect(')');
    return args;
  }

  parseArrayItems(close) {
    const items = [];
    while (!this.isOp(close)) {
      if (this.isOp(',')) { this.p++; items.push(null); continue; }
      if (this.accept('...')) { items.push({ key: null, v: this.parseExpr(), spread: true }); }
      else if (this.accept('&')) { items.push({ key: null, v: this.parseExpr(), byRef: true }); }
      else {
        let v = this.parseExpr(), key = null, byRef = false;
        if (this.accept('=>')) { key = v; if (this.accept('&')) byRef = true; v = this.parseExpr(); }
        items.push({ key, v, byRef });
      }
      if (!this.accept(',')) break;
    }
    this.expect(close);
    return items;
  }

  parseClosure(isStatic) {
    const l = this.tok.l;
    const doc = this.takeDoc(this.peek(0)) || this.takeDoc(this.peek(1));
    if (this.acceptId('fn')) {
      const byRef = this.accept('&');
      const fn = { name: '{closure}', byRef, params: this.parseParams(), ret: null, body: null, isGen: false, l, file: this.file, arrow: true, static: isStatic, strict: this.st.strict };
      if (this.accept(':')) fn.ret = this.parseType();
      this.expect('=>');
      this.st.fnStack.push(fn);
      const e = this.parseExpr(5);
      this.st.fnStack.pop();
      fn.body = [{ k: 'Return', e, l: e.l }];
      fn.arrowExpr = e;
      fn.endLine = this.toks[this.p - 1].l;
      fn.doc = doc;
      return { k: 'Closure', fn, l };
    }
    this.expectId('function');
    const byRef = this.accept('&');
    const fn = this.parseFunctionRest('{closure}', byRef, l, { closure: true, static: isStatic });
    fn.doc = doc;
    return { k: 'Closure', fn, l };
  }

  parsePrimary() {
    const t = this.tok, l = t.l;
    switch (t.t) {
      case 'var': this.p++; return { k: 'Var', name: t.v, l };
      case 'int': this.p++; return { k: 'Lit', v: t.v, l };
      case 'float': this.p++; return { k: 'Lit', v: mkf(t.v), l };
      case 'str': this.p++; return { k: 'Lit', v: t.v, l };
      case 'tpl': this.p++; return { k: 'Interp', parts: this.interpParts(t.v), l };
      case 'shell': this.p++; return { k: 'Shell', parts: this.interpParts(t.v), l };
      case 'op':
        if (t.v === '#[') { // attributes on a closure or arrow function
          const attrs = this.parseAttributes();
          const e = this.parsePrimary();
          if (e.k !== 'Closure') this.unexpected();
          e.fn.attrs = attrs;
          return e;
        }
        if (t.v === '(') { this.p++; const e = this.parseExpr(); this.expect(')'); return e; }
        if (t.v === '[') { this.p++; return { k: 'Arr', items: this.parseArrayItems(']'), l }; }
        if (t.v === '$') {
          this.p++;
          if (this.accept('{')) { const e = this.parseExpr(); this.expect('}'); return { k: 'VarVar', e, l }; }
          return { k: 'VarVar', e: this.parsePrimaryVarOnly(), l };
        }
        if (t.v === '&') this.error('syntax error, unexpected token "&"');
        this.unexpected();
      // falls through
      case 'id': {
        const kw = t.v.toLowerCase();
        const nx = this.peek();
        const nxOp = nx.t === 'op' ? nx.v : null;
        switch (kw) {
          case 'true': if (nxOp !== '::' && nxOp !== '\\') { this.p++; return { k: 'Lit', v: true, l }; } break;
          case 'false': if (nxOp !== '::') { this.p++; return { k: 'Lit', v: false, l }; } break;
          case 'null': if (nxOp !== '::') { this.p++; return { k: 'Lit', v: null, l }; } break;
          case 'array': if (nxOp === '(') { this.p += 2; return { k: 'Arr', items: this.parseArrayItems(')'), l }; } break;
          case 'list': if (nxOp === '(') { this.p += 2; return this.toList({ k: 'Arr', items: this.parseArrayItems(')'), l }); } break;
          case 'eval': {
            if (nxOp !== '(') break;
            this.p++; this.expect('('); const e = this.parseExpr(); this.expect(')');
            return { k: 'Eval', e, l, ns: this.st.ns, uses: this.st.uses, useFns: this.st.useFns, useConsts: this.st.useConsts };
          }
          case 'isset': {
            this.p++; this.expect('(');
            const list = [this.parseExpr()]; while (this.accept(',')) { if (this.isOp(')')) break; list.push(this.parseExpr()); }
            this.expect(')');
            return { k: 'Isset', list, l };
          }
          case 'empty': { this.p++; this.expect('('); const e = this.parseExpr(); this.expect(')'); return { k: 'Empty', e, l }; }
          case 'exit': case 'die': {
            this.p++;
            let e = null;
            if (this.accept('(')) { if (!this.isOp(')')) e = this.parseExpr(); this.expect(')'); }
            return { k: 'Exit', e, l };
          }
          case 'function': case 'fn': return this.parseClosure(false);
          case 'static':
            if (nx.t === 'id' && (nx.v.toLowerCase() === 'function' || nx.v.toLowerCase() === 'fn')) { this.p++; return this.parseClosure(true); }
            break;
          case 'match': if (nxOp === '(') return this.parseMatch(); break;
          case 'new': return this.parseNew();
        }
        if (MAGIC.has(kw) && nxOp !== '(' && nxOp !== '::') {
          this.p++;
          return this.magic(kw, l);
        }
        this.p++;
        const name = t.v;
        if (nxOp === '(') {
          const [fname, fb] = this.resolveFn(name);
          const args = this.parseArgs();
          return { k: 'Call', f: fname, fb, args, l };
        }
        if (nxOp === '::') return { k: 'Name', name: this.resolveClass(name), l };
        const [cname, fb] = this.resolveConst(name);
        return { k: 'Const', name: cname, fb, l };
      }
      case 'cast': return this.parseUnary();
    }
    this.unexpected();
  }
  parsePrimaryVarOnly() {
    const t = this.tok;
    if (t.t === 'var') { this.p++; return { k: 'Var', name: t.v, l: t.l }; }
    if (this.isOp('$')) { this.p++; if (this.accept('{')) { const e = this.parseExpr(); this.expect('}'); return { k: 'VarVar', e, l: t.l }; } return { k: 'VarVar', e: this.parsePrimaryVarOnly(), l: t.l }; }
    this.unexpected();
  }
  magic(kw, l) {
    const fn = this.st.fnStack[this.st.fnStack.length - 1];
    const cd = this.st.clsStack[this.st.clsStack.length - 1];
    switch (kw) {
      case '__line__': return { k: 'Lit', v: l, l };
      case '__file__': return { k: 'Lit', v: this.file, l };
      case '__dir__': return { k: 'Lit', v: pathMod.dirname(this.file), l };
      case '__namespace__': return { k: 'Lit', v: this.st.ns, l };
      case '__function__': return { k: 'Lit', v: fn ? (fn.name === '{closure}' ? '{closure}' : fn.name) : '', l };
      case '__class__': return cd && cd.kind !== 'trait' && !cd.anon ? { k: 'Lit', v: cd.name, l } : { k: 'MagicClass', l };
      case '__trait__': return { k: 'Lit', v: cd && cd.kind === 'trait' ? cd.name : '', l };
      case '__method__': {
        if (!fn) return { k: 'Lit', v: '', l };
        if (cd && fn.cls !== undefined) return cd.kind === 'trait' ? { k: 'MagicMethod', name: fn.name, l } : { k: 'Lit', v: (cd.anon ? 'class@anonymous' : cd.name) + '::' + fn.name, l };
        return { k: 'Lit', v: fn.name, l };
      }
    }
  }
  parseMatch() {
    const l = this.next().l;
    this.expect('('); const e = this.parseExpr(); this.expect(')');
    this.expect('{');
    const arms = [];
    while (!this.accept('}')) {
      let conds = null;
      if (this.acceptId('default')) { /* default arm */ }
      else { conds = [this.parseExpr()]; while (this.accept(',')) { if (this.isOp('=>')) break; conds.push(this.parseExpr()); } }
      this.expect('=>');
      const body = this.parseExpr();
      arms.push({ conds, body });
      if (!this.accept(',')) { this.expect('}'); break; }
    }
    return { k: 'Match', e, arms, l };
  }

  parsePostfix(e) {
    for (;;) {
      const t = this.tok;
      if (t.t !== 'op') break;
      const l = t.l;
      if (t.v === '{' && (e.k === 'Var' || e.k === 'Index' || e.k === 'Prop' || e.k === 'SProp')) this.fatal('Array and string offset access syntax with curly braces is no longer supported');
      switch (t.v) {
        case '[': {
          this.p++;
          if (this.accept(']')) { e = { k: 'Index', o: e, i: null, l }; continue; }
          const i = this.parseExpr(); this.expect(']');
          e = { k: 'Index', o: e, i, l }; continue;
        }
        case '{': {
          if (e.k === 'Var' || e.k === 'Index' || e.k === 'Prop') this.error('syntax error, unexpected token "{"');
          return e;
        }
        case '->': case '?->': {
          this.p++;
          const nullsafe = t.v === '?->';
          let name;
          const nt = this.tok;
          if (nt.t === 'id') { this.p++; name = nt.v; }
          else if (nt.t === 'var') { this.p++; name = { k: 'Var', name: nt.v, l: nt.l }; }
          else if (this.accept('{')) { name = this.parseExpr(); this.expect('}'); }
          else if (nt.t === 'op' && nt.v === '$') name = this.parsePrimaryVarOnly();
          else this.unexpected();
          if (this.isOp('(')) { const args = this.parseArgs(); e = { k: 'MCall', o: e, name, args, nullsafe, l }; }
          else e = { k: 'Prop', o: e, name, nullsafe, l };
          continue;
        }
        case '::': {
          this.p++;
          const cls = e.k === 'Name' ? e.name : e;
          const nt = this.tok;
          if (nt.t === 'var') {
            this.p++;
            if (this.isOp('(')) { // A::$fn() calls the static method named by $fn
              const args = this.parseArgs();
              e = { k: 'SCall', cls, name: { k: 'Var', name: nt.v, l }, args, l };
            } else e = { k: 'SProp', cls, name: nt.v, l };
            continue;
          }
          if (nt.t === 'op' && nt.v === '$') {
            const ne = this.parsePrimaryVarOnly();
            if (this.isOp('(')) { const args = this.parseArgs(); e = { k: 'SCall', cls, name: ne, args, l }; continue; }
            e = { k: 'SProp', cls, name: ne.k === 'VarVar' ? ne.e : ne, l }; continue;
          }
          if (nt.t === 'op' && nt.v === '{') { this.p++; const ne = this.parseExpr(); this.expect('}'); const args = this.parseArgs(); e = { k: 'SCall', cls, name: ne, args, l }; continue; }
          if (nt.t !== 'id') this.unexpected();
          this.p++;
          if (this.isOp('(')) { const args = this.parseArgs(); e = { k: 'SCall', cls, name: nt.v, args, l }; continue; }
          if (nt.v.toLowerCase() === 'class') { e = { k: 'ClassName', cls, l }; continue; }
          e = { k: 'CConst', cls, name: nt.v, l };
          continue;
        }
        case '(': {
          if (e.k === 'Lit' || e.k === 'Name') return e;
          const args = this.parseArgs();
          e = { k: 'Call', f: e, args, l };
          continue;
        }
        case '++': this.p++; e = { k: 'PostInc', e, l }; continue;
        case '--': this.p++; e = { k: 'PostDec', e, l }; continue;
      }
      break;
    }
    if (e.k === 'Name') return { k: 'Const', name: e.name, fb: null, l: e.l };
    return e;
  }

  interpParts(parts) {
    return parts.map((p) => {
      if (typeof p === 'string') return p;
      const toks = lex('<?php ' + p.code + ';', this.file);
      for (const tk of toks) tk.l += p.line - 1;
      const sub = new Parser(toks, this.file, this.st);
      const e = sub.parseExpr();
      if (!sub.isOp(';')) sub.unexpected();
      return e;
    });
  }
}

// reserved words, which the lexer turns into tokens of their own
const PHP_KEYWORDS = new Set(['abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone', 'const', 'continue',
  'declare', 'default', 'die', 'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch',
  'endwhile', 'eval', 'exit', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if', 'implements',
  'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset', 'list', 'match', 'namespace', 'new', 'or', 'print',
  'private', 'protected', 'public', 'readonly', 'require', 'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try',
  'unset', 'use', 'var', 'while', 'xor', 'yield', 'yield from', '__class__', '__dir__', '__file__', '__function__', '__line__',
  '__method__', '__namespace__', '__trait__', '__halt_compiler']);
// the lexer's and the parser's compile-time diagnostics, in source order
export function mergeCompileWarnings(toks, p) {
  const all = [...(toks.compileDeprecations || []), ...(p.st.compileWarnings || [])];
  return all.length ? all.sort((a, b) => a.l - b.l) : null;
}
const CONFUSABLE_TYPES = { boolean: 'bool', integer: 'int', double: 'float', resource: null };
export function parsePHP(src, file) {
  const toks = lex(src, file);
  const p = new Parser(toks, file);
  const ast = p.parseProgram();
  ast.strict = !!p.st.strict; // declare(strict_types=1): applies to calls from the file's top-level code
  ast.compileWarnings = mergeCompileWarnings(toks, p);
  return ast;
}
