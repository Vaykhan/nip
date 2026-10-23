// Compile-time checks: errors PHP reports for a whole file before running any of it.
//
// NIP compiles function bodies lazily, so errors PHP finds while compiling must be looked for
// here, right after parsing, to be reported for code that never runs and before any output.

import { FatalSig } from '../values.js';
import { rt } from '../runtime/state.js';

// How an expression is used: read, written (assignment target, by-ref argument, ...), unset,
// or passed as an argument whose by-ref-ness is only known at run time.
const READ = 0, WRITE = 1, UNSET = 2, ARG = 3;

export function checkProgram(ast) {
  const seen = new WeakSet();
  const fail = (msg, n) => { throw new FatalSig(msg, n.l); };
  // goto: labels and gotos of the current function, and the loops/switches/finally blocks
  // enclosing the statement being visited
  let scope = newScope(), path = [];
  const methods = new WeakSet(); // function nodes that are methods (attribute target "method")
  // the function being checked: null at the top level (which may run inside a class via
  // include), else { cls: enclosing ClassDecl or null, closure }
  let fnCtx = null, curClass = null;

  function visit(n, ctx) {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    if (Array.isArray(n)) { for (const x of n) visit(x, ctx); return; }
    seen.add(n);
    if (!n.k && Array.isArray(n.params) && Array.isArray(n.body)) { visitFunction(n); return; }
    if (typeof n.cls === 'string' && CLASS_REF_NODES.has(n.k)) checkClassRef(n.cls, n, fnCtx);
    switch (n.k) {
      case 'Lit': return;
      case 'ClassDecl': {
        checkAttrs(n.attrs, T_CLASS);
        for (const m of n.methods) { checkAttrs(m.fn.attrs, T_METHOD); methods.add(m.fn); }
        for (const p of n.props) { checkAttrs(p.attrs, T_PROPERTY); if (p.type) checkType(p.type, p, { cls: n, closure: false }); }
        for (const c of n.consts) checkAttrs(c.attrs, T_CLASS_CONSTANT);
        for (const c of n.cases) checkAttrs(c.attrs, T_CLASS_CONSTANT);
        const outer = curClass;
        curClass = n;
        try { for (const key in n) if (key !== 'l') visit(n[key], READ); } finally { curClass = outer; }
        return;
      }
      case 'Index':
        if (n.i === null) {
          if (n.o && n.o.k === 'Var' && n.o.name === 'GLOBALS') fail('Cannot append to $GLOBALS', n);
          if (ctx === READ) fail('Cannot use [] for reading', n);
          if (ctx === UNSET) fail('Cannot use [] for unsetting', n);
        }
        visit(n.o, ctx === READ ? READ : ctx === UNSET ? UNSET : WRITE);
        visit(n.i, READ);
        return;
      case 'Prop':
        visit(n.o, ctx === READ ? READ : WRITE);
        if (typeof n.name === 'object') visit(n.name, READ);
        return;
      case 'Assign': case 'AssignOp': visit(n.t, WRITE); visit(n.e, READ); return;
      case 'AssignRef': visit(n.t, WRITE); visit(n.e, WRITE); return;
      case 'PreInc': case 'PreDec': case 'PostInc': case 'PostDec': visit(n.e, WRITE); return;
      case 'Unset': visit(n.list, UNSET); return;
      case 'Arr':
        if (ctx !== WRITE) break;
      // falls through: [$a, $b] = ... destructuring
      case 'List': {
        const items = (n.items || []).filter(Boolean);
        if (!items.length) fail('Cannot use empty list', n);
        if (items.some((it) => it.spread)) fail('Spread operator is not supported in assignments', n);
        if (items.some((it) => it.key) && items.some((it) => !it.key)) fail('Cannot mix keyed and unkeyed array entries in assignments', n);
        for (const it of items) { visit(it.key, READ); visit(it.v, WRITE); }
        return;
      }
      case 'Call': visit(n.f, READ); visitArgs(n.args, typeof n.f === 'string' ? builtin(n) : null); return;
      case 'MCall': case 'NullsafeMCall': visit(n.o, READ); if (typeof n.name === 'object') visit(n.name, READ); visitArgs(n.args, null); return;
      case 'SCall': case 'New': visit(n.cls, READ); if (typeof n.name === 'object') visit(n.name, READ); visitArgs(n.args, null); return;
      case 'Label':
        if (scope.labels.has(n.name)) fail(`Label '${n.name}' already defined`, n);
        scope.labels.set(n.name, path.slice());
        return;
      case 'Goto': scope.gotos.push({ n, path: path.slice() }); return;
      case 'Return': visit(n.e, scope.byRef ? WRITE : READ); return; // function &f() { return $a[]; }
      case 'While': case 'DoWhile': case 'For': case 'Foreach': case 'Switch': {
        const { body, cases, ...rest } = n;
        const writes = (key) => key === 'kv' || key === 'v' || (key === 'e' && n.k === 'Foreach' && n.byRef);
        for (const key in rest) if (key !== 'l' && key !== 'k') visit(rest[key], writes(key) ? WRITE : READ);
        within('loop', () => { visit(body, READ); visit(cases, READ); });
        return;
      }
      case 'Try':
        if (n.fin) scope.hasFinally = true; else scope.hasTryWithoutFinally = true;
        within('try', () => { visit(n.body, READ); visit(n.catches, READ); });
        within('finally', () => visit(n.fin, READ));
        return;
    }
    for (const key in n) if (key !== 'l') visit(n[key], READ);
  }

  // A builtin known at compile time: PHP checks its by-value arguments as reads.
  function builtin(n) {
    if (n.fb && n.f.includes('\\') && !n.f.startsWith('\\')) return null; // namespaced: resolved at run time
    const fn = rt.fns.get(n.f.replace(/^\\/, '').toLowerCase());
    return fn && fn.native ? fn : null;
  }
  function visitArgs(args, fn) {
    if (!Array.isArray(args)) return;
    args.forEach((a, i) => {
      if (!a) return;
      const e = a.e !== undefined ? a.e : a;
      if (a.spread || a.name) { visit(e, ARG); return; }
      const byRef = !fn || (fn.refs && fn.refs[i]) || (fn.refRest !== null && i >= fn.refRest);
      visit(e, byRef ? ARG : READ);
    });
  }

  // the attribute classes of the engine are validated at compile time; user ones only by
  // ReflectionAttribute::newInstance()
  function checkAttrs(attrs, target) {
    if (!attrs) return;
    const seen = new Set();
    for (const a of attrs) {
      const ln = (a.name[0] === '\\' ? a.name.slice(1) : a.name).toLowerCase();
      const known = ENGINE_ATTRS[ln];
      if (!known) continue;
      if (!(known.flags & target)) {
        const allowed = TARGET_NAMES.filter(([b]) => known.flags & b).map(([, t]) => t).join(', ');
        fail(`Attribute "${known.name}" cannot target ${TARGET_NAMES.find(([b]) => b === target)[1]} (allowed targets: ${allowed})`, a);
      }
      if (seen.has(ln)) fail(`Attribute "${known.name}" must not be repeated`, a);
      seen.add(ln);
    }
  }
  // self/static/parent need a class: a compile error in named functions outside classes
  // (closures may be bound to one later)
  function checkClassRef(name, n, ctx) {
    const ln = name.toLowerCase();
    if (!ctx || ctx.closure || (ln !== 'self' && ln !== 'static' && ln !== 'parent')) return;
    if (!ctx.cls) fail(`Cannot use "${ln}" when no class scope is active`, n);
    if (ln === 'parent' && ctx.cls && ctx.cls.kind !== 'trait' && !ctx.cls.parent) fail('Cannot use "parent" when current class scope has no parent', n);
  }
  function checkType(t, n, ctx) {
    for (const a of t.alts) {
      if (typeof a === 'string') checkClassRef(a, n, ctx);
      else for (const x of a.inter) checkClassRef(x, n, ctx);
    }
  }
  function within(kind, fn) { path.push({ kind }); try { fn(); } finally { path.pop(); } }
  function visitFunction(fn) {
    const outer = scope, outerPath = path, outerCtx = fnCtx;
    const closure = fn.name === '{closure}';
    fnCtx = { cls: methods.has(fn) ? curClass : closure && fnCtx ? fnCtx.cls : closure ? curClass : null, closure };
    for (const p of fn.params) if (p.type) checkType(p.type, fn, fnCtx);
    if (fn.ret) checkType(fn.ret, fn, fnCtx);
    scope = newScope(); path = [];
    scope.byRef = !!fn.byRef;
    if (!methods.has(fn)) checkAttrs(fn.attrs, T_FUNCTION);
    for (const p of fn.params) checkAttrs(p.attrs, T_PARAMETER);
    visit(fn.params, READ); visit(fn.body, READ); visit(fn.arrowExpr, READ);
    checkGotos(scope, !fn.params.length && !fn.isGen ? fn.body : null);
    scope = outer; path = outerPath; fnCtx = outerCtx;
  }
  // body: the statements, when a leading goto would be the function's first opcode
  function checkGotos(sc, body) {
    // PHP 8.3 quirk: in a function that has a finally block, its check for jumps out of finally
    // blocks treats every try without finally as covering opcode 0, so a goto compiled as the
    // very first opcode is rejected (zend_check_finally_breakout)
    if (body && sc.hasFinally && sc.hasTryWithoutFinally) {
      const first = body.find((st) => st && !NO_OPCODES.has(st.k));
      if (first && first.k === 'Goto') fail('jump out of a finally block is disallowed', first);
    }
    for (const { n, path: from } of sc.gotos) {
      const to = sc.labels.get(n.label);
      if (!to) fail(`'goto' to undefined label '${n.label}'`, n);
      let p = 0;
      while (p < to.length && p < from.length && to[p] === from[p]) p++;
      for (const c of to.slice(p)) {
        if (c.kind === 'loop') fail("'goto' into loop or switch statement is disallowed", n);
        if (c.kind === 'finally') fail('jump into a finally block is disallowed', n);
      }
      if (from.slice(p).some((c) => c.kind === 'finally')) fail('jump out of a finally block is disallowed', n);
    }
  }

  visit(ast, READ);
  checkGotos(scope, ast);
}

// statements that compile to no opcodes of their own
const NO_OPCODES = new Set(['Label', 'FuncDecl']);

function newScope() { return { labels: new Map(), gotos: [] }; }

const CLASS_REF_NODES = new Set(['CConst', 'ClassName', 'New', 'SCall', 'SProp', 'Instanceof']);
const T_CLASS = 1, T_FUNCTION = 2, T_METHOD = 4, T_PROPERTY = 8, T_CLASS_CONSTANT = 16, T_PARAMETER = 32;
const TARGET_NAMES = [[T_CLASS, 'class'], [T_FUNCTION, 'function'], [T_METHOD, 'method'], [T_PROPERTY, 'property'], [T_CLASS_CONSTANT, 'class constant'], [T_PARAMETER, 'parameter']];
const ENGINE_ATTRS = {
  attribute: { name: 'Attribute', flags: T_CLASS },
  override: { name: 'Override', flags: T_METHOD },
  allowdynamicproperties: { name: 'AllowDynamicProperties', flags: T_CLASS },
  returntypewillchange: { name: 'ReturnTypeWillChange', flags: T_METHOD },
  sensitiveparameter: { name: 'SensitiveParameter', flags: T_PARAMETER },
};
