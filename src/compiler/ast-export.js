// Source text for an AST, as PHP prints it (zend_ast_export): the message of a failed assert()
// without a description is "assert(<argument>)". Operators get parentheses from their priority
// (PHP's numbers below), not from how the source was written.

import { Flt, fmtFloat, PHPArray } from '../values.js';
import { rt } from '../runtime/state.js';

const AX_BIN = { // op: [text, priority, left priority, right priority]
  '+': [' + ', 200, 200, 201], '-': [' - ', 200, 200, 201], '*': [' * ', 210, 210, 211], '/': [' / ', 210, 210, 211],
  '%': [' % ', 210, 210, 211], '<<': [' << ', 190, 190, 191], '>>': [' >> ', 190, 190, 191], '.': [' . ', 185, 185, 186],
  '|': [' | ', 140, 140, 141], '&': [' & ', 160, 160, 161], '^': [' ^ ', 150, 150, 151],
  '===': [' === ', 170, 171, 171], '!==': [' !== ', 170, 171, 171], '==': [' == ', 170, 171, 171], '!=': [' != ', 170, 171, 171],
  '<': [' < ', 180, 181, 181], '<=': [' <= ', 180, 181, 181], '>': [' > ', 180, 181, 181], '>=': [' >= ', 180, 181, 181],
  '<=>': [' <=> ', 180, 181, 181], '**': [' ** ', 250, 251, 250],
};
const AX_CASTS = { int: '(int)', integer: '(int)', bool: '(bool)', boolean: '(bool)', string: '(string)', binary: '(string)', array: '(array)', object: '(object)', unset: '(unset)' };
const axV85 = () => rt.phpVersion >= 80500;

const axIndentStr = (n) => '    '.repeat(Math.max(0, n));
// a string in single quotes
const axSq = (s) => "'" + s.replace(/[\\']/g, '\\$&') + "'";
// a string inside "..." or `...`
function axQstr(s, quote) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 32) {
      out += { 10: '\\n', 13: '\\r', 9: '\\t', 12: '\\f', 11: '\\v', 27: '\\e' }[c] || '\\0' + String.fromCharCode(48 + (c >> 3)) + String.fromCharCode(48 + (c & 7));
    } else out += (ch === quote || ch === '$' || ch === '\\' ? '\\' : '') + ch;
  }
  return out;
}
const axValidVarName = (s) => /^[A-Za-z_\x7f-\xff][A-Za-z0-9_\x7f-\xff]*$/.test(s);

function axZval(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Flt) {
    const s = fmtFloat(v.v, rt.precision);
    return /^-?\d+$/.test(s) ? s + '.0' : s;
  }
  if (typeof v === 'string') return axSq(v);
  if (v instanceof PHPArray) return '[' + v.entries().map(([k, x]) => (typeof k === 'string' ? axSq(k) : String(k)) + ' => ' + axZval(x)).join(', ') + ']';
  return '';
}
// a class or function name as written
const axNsName = (raw, resolved) => (raw !== undefined ? raw : resolved);
function axNameOrExpr(name, raw, ind) {
  if (typeof name === 'string') return axNsName(raw, name);
  return axExp(name, 0, ind);
}
// a property or method name: $x->name, $x->$var, $x->{expr}
function axVarName(name, ind) {
  if (typeof name === 'string') return axValidVarName(name) ? name : '{' + axSq(name) + '}';
  if (name && (name.k === 'Var' || name.k === 'VarVar')) return axExp(name, 0, ind);
  if (name && name.k === 'Lit' && typeof name.v === 'string' && axValidVarName(name.v)) return name.v;
  return '{' + axExp(name, 0, ind) + '}';
}
function axTypeStr(t) {
  if (!t) return '';
  if (t.q) return '?' + axTypeAlt(t.raw[0]);
  return t.raw.map(axTypeAlt).join('|');
}
const axTypeAlt = (a) => (typeof a === 'string' ? a : a.inter.join('&'));

function axArgs(list, ind) {
  if (list === 'fcc') return '...';
  return (list || []).map((a) => (a.spread ? '...' : '') + (a.name ? a.name + ': ' : '') + axExp(a.e, 0, ind)).join(', ');
}
function axAttrs(list, ind, newlines) {
  if (!list || !list.length) return '';
  let out = '', cur = -1, items = [];
  const flush = () => { if (!items.length) return; out += '#[' + items.join(', ') + ']' + (newlines ? '\n' + axIndentStr(ind) : ' '); items = []; };
  for (const a of list) {
    if (a.group !== cur) { flush(); cur = a.group; }
    items.push((a.raw ?? a.name) + (a.args && a.args.length ? '(' + axArgs(a.args, ind) + ')' : ''));
  }
  flush();
  return out;
}
function axEncaps(parts, quote, ind) {
  let out = '';
  parts.forEach((p, i) => {
    if (typeof p === 'string') { out += axQstr(p, quote); return; }
    const next = parts[i + 1];
    const simple = (p.k === 'Var' && typeof p.name === 'string') || (p.k === 'VarVar' && p.e.k === 'Lit' && typeof p.e.v === 'string');
    const plain = simple && (typeof next !== 'string' || !/^[[A-Za-z0-9_\x7f-\xff]/.test(next));
    out += plain ? axExp(p, 0, ind) : '{' + axExp(p, 0, ind) + '}';
  });
  return out;
}
function axParams(ps, ind) {
  return ps.map((p) => {
    let s = axAttrs(p.attrs, ind, false);
    if (p.promote) s += p.promote + ' ';
    if (p.type) s += axTypeStr(p.type) + ' ';
    if (p.byRef) s += '&';
    if (p.variadic) s += '...';
    s += '$' + p.name;
    if (p.def) s += ' = ' + axExp(p.def, 0, ind);
    return s;
  }).join(', ');
}
function axFuncDecl(fn, ind, kind, mods = '', inParens = false) {
  let s = '';
  const paren = kind === 'arrow' && inParens && axV85();
  if (paren) s += '(';
  s += axAttrs(fn.attrs, ind, kind === 'function' || kind === 'method');
  s += mods;
  if (fn.static && kind !== 'method') s += 'static ';
  s += kind === 'arrow' ? 'fn' : 'function ';
  if (fn.byRef) s += '&';
  if (kind === 'function' || kind === 'method') s += fn.name.split('\\').pop();
  s += '(' + axParams(fn.params, ind) + ')';
  if (fn.uses && fn.uses.length) s += ' use(' + fn.uses.map((u) => (u.byRef ? '&' : '') + '$' + u.name).join(', ') + ')';
  if (fn.ret) s += ': ' + axTypeStr(fn.ret);
  if (kind === 'arrow') return s + ' => ' + axExp(fn.arrowExpr, 0, ind) + (paren ? ')' : '');
  if (fn.body === null) return s + ';\n';
  s += ' {\n' + axStmts(fn.body, ind + 1) + axIndentStr(ind) + '}';
  return kind === 'closure' ? s : s + '\n';
}
// class members in source order
function axClassBody(cd, ind) {
  const members = [];
  for (const t of cd.traits) members.push([t.seq || 0, () => {
    let s = 'use ' + t.names.join(', ');
    if (!t.rules.length) return s + ';';
    s += ' {\n';
    for (const r of t.rules) {
      s += axIndentStr(ind + 2) + (r.trait ? r.trait + '::' : '') + r.method;
      if (r.kind === 'insteadof') s += ' insteadof ' + r.excl.join(', ');
      else s += (r.vis ? ' as ' + r.vis : ' as') + (r.alias ? ' ' + r.alias : '');
      s += ';\n';
    }
    return s + axIndentStr(ind + 1) + '}';
  }]);
  for (const c of cd.cases) members.push([c.seq, () => axAttrs(c.attrs, ind + 1, true) + 'case ' + c.name + (c.e ? ' = ' + axExp(c.e, 0, ind + 1) : '') + ';']);
  const cgroups = new Map();
  for (const c of cd.consts) { const g = c.group ?? c.seq; if (!cgroups.has(g)) cgroups.set(g, []); cgroups.get(g).push(c); }
  for (const cs of cgroups.values()) {
    const c0 = cs[0];
    members.push([c0.seq, () => axAttrs(c0.attrs, ind + 1, true) + (c0.final ? 'final ' : '') + c0.vis + ' const ' + (c0.type ? axTypeStr(c0.type) + ' ' : '') + cs.map((c) => c.name + ' = ' + axExp(c.e, 20, ind + 1)).join(', ') + ';']);
  }
  const groups = new Map();
  for (const p of cd.props) { const g = p.group ?? p.seq; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  for (const ps of groups.values()) {
    const p0 = ps[0];
    members.push([p0.seq, () => axAttrs(p0.attrs, ind + 1, true) + (p0.visKw ? p0.visKw + ' ' : '') + (p0.static ? 'static ' : '') + (p0.readonly ? 'readonly ' : '') + (p0.type ? axTypeStr(p0.type) + ' ' : '') +
      ps.map((p) => '$' + p.name + (p.hasDef ? ' = ' + axExp(p.def, 0, ind + 2) : '')).join(', ') + ';']);
  }
  for (const m of cd.methods) {
    const mods = m.vis + ' ' + (m.static ? 'static ' : '') + (m.abstractKw ? 'abstract ' : '') + (m.final ? 'final ' : '');
    members.push([m.seq, () => axFuncDecl(m.fn, ind + 1, 'method', mods)]);
  }
  members.sort((a, b) => a[0] - b[0]);
  let s = '';
  if (cd.parent) s += ' extends ' + cd.parent;
  if (cd.interfaces && cd.interfaces.length) s += ' implements ' + cd.interfaces.join(', ');
  s += ' {\n';
  for (const [, f] of members) s += axIndentStr(ind + 1) + f() + '\n';
  return s + axIndentStr(ind) + '}';
}
function axClassDecl(cd, ind) {
  let s = axAttrs(cd.attrs, ind, true);
  if (cd.kind === 'interface') s += 'interface ';
  else if (cd.kind === 'trait') s += 'trait ';
  else if (cd.kind === 'enum') s += 'enum ';
  else s += (cd.flags.abstract ? 'abstract ' : '') + (cd.flags.final ? 'final ' : '') + (cd.flags.readonly ? 'readonly ' : '') + 'class ';
  s += cd.name.split('\\').pop();
  if (cd.kind === 'enum' && cd.enumType) s += ': ' + axTypeStr(cd.enumType);
  return s + axClassBody(cd, ind) + '\n';
}

function axWrap(priority, p, s) { return priority > p ? '(' + s + ')' : s; }
function axBin(n, a, b, [op, p, pl, pr], priority, ind) { return axWrap(priority, p, axExp(a, pl, ind) + op + axExp(b, pr, ind)); }
function axPrefix(op, e, priority, p, pl, ind) { return axWrap(priority, p, op + axExp(e, pl, ind)); }

export function axExp(n, priority = 0, ind = 0) {
  if (n === null || n === undefined) return '';
  switch (n.k) {
    case 'Lit': return n.magic ? n.magic : axZval(n.v);
    case 'MagicClass': return '__CLASS__';
    case 'MagicMethod': return '__METHOD__';
    case 'Paren': return axExp(n.e, priority, ind);
    case 'Interp': return '"' + axEncaps(n.parts, '"', ind) + '"';
    case 'Shell': return '`' + axEncaps(n.parts, '`', ind) + '`';
    case 'Var': return '$' + (typeof n.name === 'string' ? (axValidVarName(n.name) ? n.name : '{' + n.name + '}') : '{' + axExp(n.name, 0, ind) + '}');
    case 'VarVar':
      if (n.e.k === 'Lit' && typeof n.e.v === 'string') return axExp({ k: 'Var', name: n.e.v }, priority, ind); // ${'name'}
      return '$' + (n.e.k === 'Var' || n.e.k === 'VarVar' ? axExp(n.e, 0, ind) : '{' + axExp(n.e, 0, ind) + '}');
    case 'Index': return axExp(n.o, 260, ind) + '[' + (n.i ? axExp(n.i, 0, ind) : '') + ']';
    case 'Prop': return axExp(n.o, 0, ind) + (n.nullsafe ? '?->' : '->') + axVarName(n.name, ind);
    case 'SProp': return axNameOrExpr(n.cls, n.rawCls, ind) + '::$' + (typeof n.name === 'string' ? n.name : axVarName(n.name, ind));
    case 'Arr': case 'List': return '[' + n.items.map((it) => {
      if (!it) return '';
      if (it.spread) return '...' + axExp(it.v, 0, ind);
      return (it.key ? axExp(it.key, 80, ind) + ' => ' : '') + (it.byRef ? '&' : '') + axExp(it.v, 80, ind);
    }).join(', ') + ']';
    case 'Const': return n.raw ?? n.name;
    case 'CConst': return axNameOrExpr(n.cls, n.rawCls, ind) + '::' + (typeof n.name === 'string' ? n.name : axExp(n.name, 0, ind));
    case 'ClassName': return axNameOrExpr(n.cls, n.rawCls, ind) + '::class';
    case 'Assign': return axBin(n, n.t, n.e, [' = ', 90, 91, 90], priority, ind);
    case 'AssignRef': return axBin(n, n.t, n.e, [' =& ', 90, 91, 90], priority, ind);
    case 'AssignOp': return axBin(n, n.t, n.e, [' ' + n.op + '= ', 90, 91, 90], priority, ind);
    case 'PreInc': return axPrefix('++', n.e, priority, 240, 241, ind);
    case 'PreDec': return axPrefix('--', n.e, priority, 240, 241, ind);
    case 'PostInc': return axWrap(priority, 240, axExp(n.e, 241, ind) + '++');
    case 'PostDec': return axWrap(priority, 240, axExp(n.e, 241, ind) + '--');
    case 'Bin': return axBin(n, n.a, n.b, AX_BIN[n.op] || [' ' + n.op + ' ', 0, 0, 0], priority, ind);
    case 'And': return axBin(n, n.a, n.b, [' && ', 130, 130, 131], priority, ind);
    case 'Or': return axBin(n, n.a, n.b, [' || ', 120, 120, 121], priority, ind);
    case 'Xor': return axBin(n, n.a, n.b, [' xor ', 40, 40, 41], priority, ind);
    case 'Coalesce': return axBin(n, n.a, n.b, [' ?? ', 110, 111, 110], priority, ind);
    case 'Pipe': return axBin(n, n.a, n.b, [' |> ', 183, 183, 184], priority, ind);
    case 'Not': return axPrefix('!', n.e, priority, 240, 241, ind);
    case 'Neg': return axPrefix('-', n.e, priority, 240, 241, ind);
    case 'Plus': return axPrefix('+', n.e, priority, 240, 241, ind);
    case 'BitNot': return axPrefix('~', n.e, priority, 240, 241, ind);
    case 'Silence': return axPrefix('@', n.e, priority, 240, 241, ind);
    case 'Cast': {
      const t = n.t.toLowerCase();
      const op = AX_CASTS[t] || (t === 'float' || t === 'double' || t === 'real' ? (axV85() ? '(float)' : '(double)') : '(' + t + ')');
      return axPrefix(op, n.e, priority, 240, 241, ind);
    }
    case 'Ternary': return axWrap(priority, 100, axExp(n.c, 100, ind) + (n.a ? ' ? ' + axExp(n.a, 101, ind) + ' : ' : ' ?: ') + axExp(n.b, 101, ind));
    case 'Isset': return 'isset(' + n.list.map((e) => axExp(e, 0, ind)).join(', ') + ')';
    case 'Empty': return 'empty(' + axExp(n.e, 0, ind) + ')';
    case 'Instanceof': return axExp(n.e, 0, ind) + ' instanceof ' + axNameOrExpr(n.cls, n.rawCls, ind);
    case 'Clone':
      if (axV85()) return '\\clone(' + axExp(n.e, 0, ind) + ')';
      return axPrefix('clone ', n.e, priority, 270, 271, ind);
    case 'Print': return axPrefix('print ', n.e, priority, 60, 61, ind);
    case 'Exit':
      if (rt.phpVersion >= 80400) return '\\exit(' + (n.e ? axExp(n.e, 0, ind) : '') + ')';
      return n.e ? 'exit(' + axExp(n.e, 0, ind) + ')' : 'exit';
    case 'Throw': return 'throw ' + axExp(n.e, 0, ind);
    case 'Include': return n.kind + '(' + axExp(n.e, 0, ind) + ')';
    case 'Eval': return 'eval(' + axExp(n.e, 0, ind) + ')';
    case 'Yield': return axWrap(priority, 70, 'yield ' + (n.v ? (n.key ? axExp(n.key, 70, ind) + ' => ' : '') + axExp(n.v, 70, ind) : ''));
    case 'YieldFrom': return axPrefix('yield from ', n.e, priority, 85, 86, ind);
    case 'Match': return 'match (' + axExp(n.e, 0, ind) + ') {\n' + n.arms.map((a) => axIndentStr(ind + 1) + (a.conds ? a.conds.map((c) => axExp(c, 0, ind + 1)).join(', ') + ' => ' : 'default => ') + axExp(a.body, 0, 0) + ',\n').join('') + axIndentStr(ind) + '}';
    case 'Closure': return axFuncDecl(n.fn, ind, n.fn.arrow ? 'arrow' : 'closure', '', n.inParens);
    case 'New': {
      if (n.cls && n.cls.k === 'ClassDecl') {
        const cd = n.cls;
        return 'new ' + axAttrs(cd.attrs, ind, false) + 'class' + (n.args && n.args.length ? '(' + axArgs(n.args, ind) + ')' : '') + axClassBody(cd, ind);
      }
      return 'new ' + axNameOrExpr(n.cls, n.rawCls, ind) + '(' + axArgs(n.args, ind) + ')';
    }
    case 'Call': {
      let f;
      if (typeof n.f === 'string') f = n.raw ?? n.fb ?? n.f;
      else if (n.f.k === 'Closure' && axV85()) f = '(' + axExp(n.f, 0, ind) + ')';
      else f = axExp(n.f, 0, ind);
      return f + '(' + axArgs(n.args, ind) + ')';
    }
    case 'MCall': return axExp(n.o, 0, ind) + (n.nullsafe ? '?->' : '->') + axVarName(n.name, ind) + '(' + axArgs(n.args, ind) + ')';
    case 'SCall': return axNameOrExpr(n.cls, n.rawCls, ind) + '::' + axVarName(n.name, ind) + '(' + axArgs(n.args, ind) + ')';
    case 'TempObj': case 'Temp': return '';
  }
  return '';
}

const axDeclareItems = (items, ind) => items.map((it) => it.name + ' = ' + axExp(it.e, 0, ind)).join(', ');
function axBlock(b, ind) { return axStmts(b && b.k === 'Block' ? b.body : b ? [b] : [], ind); }
function axStmts(list, ind) {
  let out = '';
  for (const s of list || []) out += axStmt(s, ind);
  return out;
}
function axStmt(s, ind) {
  if (!s) return '';
  const pre = axIndentStr(ind);
  const semi = (t) => pre + t + ';\n';
  switch (s.k) {
    case 'Block':
      if (s.declare) return pre + 'declare(' + axDeclareItems(s.declare, ind) + ') {\n' + axStmts(s.body, ind + 1) + pre + '}\n';
      return axStmts(s.body, ind);
    case 'Nop': return s.declare ? semi('declare(' + axDeclareItems(s.declare, ind) + ')') : '';
    case 'ExprStmt': return semi(axExp(s.e, 0, ind));
    case 'Echo': return semi('echo ' + s.args.map((e) => axExp(e, 20, ind)).join(', '));
    case 'Return': return semi('return' + (s.e ? ' ' + axExp(s.e, 0, ind) : ''));
    case 'Break': return semi('break' + (s.n && s.n !== 1 ? ' ' + s.n : ''));
    case 'Continue': return semi('continue' + (s.n && s.n !== 1 ? ' ' + s.n : ''));
    case 'Unset': return semi('unset(' + s.list.map((e) => axExp(e, 0, ind)).join(', ') + ')');
    case 'Global': return s.names.map((v) => semi(typeof v === 'string' ? 'global $' + v : 'global ' + axExp(v, 0, ind))).join('');
    case 'StaticVar': return s.vars.map((v) => semi('static $' + v.name + (v.init ? ' = ' + axExp(v.init, 0, ind) : ''))).join('');
    case 'Goto': return semi('goto ' + s.label);
    case 'Label': return pre + s.name + ':\n';
    case 'ConstDecl': return semi('const ' + s.items.map((it) => it.name.split('\\').pop() + ' = ' + axExp(it.e, 0, ind)).join(', '));
    case 'If': {
      let t = pre + 'if (' + axExp(s.c, 0, ind) + ') {\n' + axBlock(s.then, ind + 1);
      for (const e of s.elifs || []) t += pre + (e.elseIf ? '} else if (' : '} elseif (') + axExp(e.c, 0, ind) + ') {\n' + axBlock(e.body, ind + 1);
      if (s.els) t += pre + '} else {\n' + axBlock(s.els, ind + 1);
      return t + pre + '}\n';
    }
    case 'While': return pre + 'while (' + axExp(s.c, 0, ind) + ') {\n' + axBlock(s.body, ind + 1) + pre + '}\n';
    case 'DoWhile': return pre + 'do {\n' + axBlock(s.body, ind + 1) + pre + '} while (' + axExp(s.c, 0, ind) + ');\n';
    case 'For': {
      const l = (xs) => (xs || []).map((e) => axExp(e, 0, ind)).join(', ');
      return pre + 'for (' + l(s.init) + ';' + (s.cond && s.cond.length ? ' ' + l(s.cond) : '') + ';' + (s.step && s.step.length ? ' ' + l(s.step) : '') + ') {\n' + axBlock(s.body, ind + 1) + pre + '}\n';
    }
    case 'Foreach': return pre + 'foreach (' + axExp(s.e, 0, ind) + ' as ' + (s.kv ? axExp(s.kv, 0, ind) + ' => ' : '') + (s.byRef ? '&' : '') + axExp(s.v, 0, ind) + ') {\n' + axBlock(s.body, ind + 1) + pre + '}\n';
    case 'Switch': return pre + 'switch (' + axExp(s.e, 0, ind) + ') {\n' + s.cases.map((c) => axIndentStr(ind + 1) + (c.test ? 'case ' + axExp(c.test, 0, ind + 1) + ':\n' : 'default:\n') + axStmts(c.body, ind + 2)).join('') + pre + '}\n';
    case 'Try': {
      let t = pre + 'try {\n' + axBlock(s.body, ind + 1);
      for (const c of s.catches) t += pre + '} catch (' + c.types.join('|') + (c.v ? ' $' + c.v : '') + ') {\n' + axBlock(c.body, ind + 1);
      if (s.fin) t += pre + '} finally {\n' + axBlock(s.fin, ind + 1);
      return t + pre + '}\n';
    }
    case 'FuncDecl': return pre + axFuncDecl(s.fn, ind, 'function') + '\n';
    case 'ClassDecl': return pre + axClassDecl(s, ind) + '\n';
  }
  return semi(axExp(s, 0, ind));
}

// the message assert() gets when called without a description
export function assertMessage(argList) { return 'assert(' + axArgs(argList, 0) + ')'; }
