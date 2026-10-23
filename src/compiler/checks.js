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

  function visit(n, ctx) {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    if (Array.isArray(n)) { for (const x of n) visit(x, ctx); return; }
    seen.add(n);
    if (!n.k && Array.isArray(n.params) && Array.isArray(n.body)) { visitFunction(n); return; }
    switch (n.k) {
      case 'Lit': return;
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

  function within(kind, fn) { path.push({ kind }); try { fn(); } finally { path.pop(); } }
  function visitFunction(fn) {
    const outer = scope, outerPath = path;
    scope = newScope(); path = [];
    visit(fn.params, READ); visit(fn.body, READ); visit(fn.arrowExpr, READ);
    checkGotos(scope, !fn.params.length && !fn.isGen ? fn.body : null);
    scope = outer; path = outerPath;
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
