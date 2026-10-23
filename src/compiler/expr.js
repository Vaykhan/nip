// Compilation of expressions and call arguments.

import cpMod from 'node:child_process';
import {
  cp, ExitSig, FatalSig, Flt, fmtReprZ, isInt, MAXS, mkf, NOREF, normKey, PHPArray, PHPObject, Ref,
  ThrowSig
} from '../values.js';
import { toBool, toDbl, toInt, toStr, typeOf } from '../convert.js';
import { cmp, isNum, looseEq, strictEq } from '../compare.js';
import {
  add, bitAnd, bitNot, bitOr, bitXor, concat, dec, div, inc, mod, mul, pow, shl, shr, sub
} from '../arith.js';
import { fromBytes } from '../utf8.js';
import { arrowFreeVars, isFresh, isLvalNode, SUPERGLOBALS, warnUndefVar } from './common.js';
import { cClassRef, cLval } from './lvalue.js';
import { iterateObject } from './stmt.js';
import { rt } from '../runtime/state.js';
import { notice, throwError } from '../runtime/errors.js';
import {
  callFunction, callNative, compileFunction, fnDisplayName, FRAME_FUNCS
} from '../runtime/functions.js';
import {
  callableToClosure, findMethod, makeClosure, methodClosure, resolveCallable
} from '../runtime/callables.js';
import {
  canAccessMember, classConst, cloneObject, declareClass, instantiate, toArrayCast, toObjectCast
} from '../runtime/classes.js';
import { dropRef, gcCheck } from '../runtime/gc.js';
import { doEval, doInclude } from '../runtime/program.js';
import { deref } from '../lib/core.js';
import { closureClass } from '../runtime/native-classes.js';
import { lazyFn } from '../runtime/boot.js';

// Fibers: while a fiber-mode body is compiled (compiler/generator.js), calls to user functions
// (and to Fiber::suspend()) return a PendingCall, which the generator code runs with yield* so
// the callee can suspend. Builtins are still called directly.
export class PendingCall {
  constructor(fn, args, thisObj, cls, sc, closure) { this.fn = fn; this.args = args; this.thisObj = thisObj; this.cls = cls; this.sc = sc; this.closure = closure; }
}
let deferCalls = false;
export function compileDeferred(compile) {
  const prev = deferCalls;
  deferCalls = true;
  try { return compile(); } finally { deferCalls = prev; }
}
function deferredCall(fn, args, thisObj, cls, sc, closure) {
  if (fn.native !== undefined && !fn.suspends) return callFunction(fn, args, thisObj, cls, sc, closure);
  return new PendingCall(fn, args, thisObj, cls, sc, closure);
}

export function cValue(n) { // expression whose value will be stored: apply copy-on-write marking
  const E = cExpr(n);
  if (isFresh(n)) return E;
  return (f) => { const v = E(f); if (v instanceof PHPArray) v.cow = true; return v; };
}


export function cExpr(n) {
  const fn = EXPR[n.k];
  if (!fn) throw new FatalSig(`Unsupported expression type ${n.k}`, n.l);
  return fn(n);
}

const EXPR = {
  Lit(n) { const v = n.v; return () => v; },
  Paren(n) { return cExpr(n.e); },
  Temp(n) { const id = n.id; return (f) => f.temps[id]; },
  Interp(n) {
    const parts = n.parts.map((p) => (typeof p === 'string' ? p : cExpr(p)));
    if (parts.length === 2) {
      const [a, b] = parts;
      if (typeof a === 'string') return (f) => { const v = b(f); return a + (typeof v === 'string' ? v : toStr(v)); };
      if (typeof b === 'string') return (f) => { const v = a(f); return (typeof v === 'string' ? v : toStr(v)) + b; };
    }
    return (f) => {
      let s = '';
      for (let i = 0; i < parts.length; i++) { const p = parts[i]; if (typeof p === 'string') s += p; else { const v = p(f); s += typeof v === 'string' ? v : toStr(v); } }
      return s;
    };
  },
  Shell(n) {
    const S = EXPR.Interp(n);
    return (f) => { const cmd = S(f); rt.flush(); try { return fromBytes(cpMod.execSync(cmd, { stdio: ['inherit', 'pipe', 'inherit'] })); } catch (e) { return e.stdout ? fromBytes(e.stdout) : null; } };
  },
  Var(n) {
    if (typeof n.name !== 'string') return cLval(n).get;
    const name = n.name;
    if (name === 'this') return (f) => { if (!f.this) throwError('Error', 'Using $this when not in object context'); return f.this; };
    if (name === 'GLOBALS' || SUPERGLOBALS.has(name)) return cLval(n).get;
    return (f) => { const r = f.vars[name]; if (r === undefined) { warnUndefVar(name); return null; } return r.v; };
  },
  VarVar(n) { return cLval(n).get; },
  Index(n) { return cLval(n).get; },
  Prop(n) { return cLval(n).get; },
  SProp(n) { return cLval(n).get; },
  List() { throw new FatalSig('Cannot use list() outside assignment context'); },
  Arr(n) {
    const items = n.items.map((it) => {
      if (!it) throw new FatalSig('Cannot use empty array elements in arrays', n.l);
      return { K: it.key ? cExpr(it.key) : null, V: it.byRef ? null : cValue(it.v), L: it.byRef ? cLval(it.v) : null, spread: it.spread };
    });
    // constant array folding
    if (n.items.every((it) => !it.spread && !it.byRef && (!it.key || it.key.k === 'Lit') && (it.v.k === 'Lit'))) {
      const a = new PHPArray();
      for (const it of n.items) { if (it.key) a.set(normKey(it.key.v), it.v.v); else a.push(it.v.v); }
      if (a.size === 0) return () => new PHPArray();
      return () => { a.cow = true; return a; };
    }
    return (f) => {
      const a = new PHPArray();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.spread) { spreadInto(a, it.V(f)); continue; }
        if (it.L) { const r = it.L.ref(f); if (it.K) a.setRaw(normKey(it.K(f)), r); else a.push(r); continue; }
        if (it.K) { const k = it.K(f); a.set(normKey(k), it.V(f)); }
        else if (!a.push(it.V(f))) { /* overflow warning issued */ }
      }
      return a;
    };
  },
  Const(n) {
    const name = n.name, fb = n.fb;
    const lname = name.toLowerCase();
    const base = lname.startsWith('\\') ? lname.slice(1) : lname;
    if (base === 'true') return () => true;
    if (base === 'false') return () => false;
    if (base === 'null') return () => null;
    if (base === 'php_eol') return () => '\n';
    return () => {
      let v = rt.consts.get(name);
      if (v !== undefined) return v;
      if (fb) { v = rt.consts.get(fb); if (v !== undefined) return v; }
      v = rt.consts.get(lname) ?? rt.consts.get(fb ? fb.toLowerCase() : '');
      if (v !== undefined && rt.constsCI.has(lname)) return v;
      throwError('Error', `Undefined constant "${name}"`);
    };
  },
  MagicClass() { return (f) => (f.cls ? f.cls.name : ''); },
  MagicMethod(n) { const name = n.name; return (f) => (f.cls ? f.cls.name + '::' + name : name); },
  Eval(n) {
    const E = cExpr(n.e);
    const st = { ns: n.ns, uses: n.uses, useFns: n.useFns, useConsts: n.useConsts };
    return (f) => doEval(toStr(E(f)), f, st);
  },
  CConst(n) {
    const C = cClassRef(n.cls);
    const name = n.name;
    return (f) => classConst(C(f), name, f);
  },
  ClassName(n) {
    if (typeof n.cls === 'string') {
      const lc = n.cls.toLowerCase();
      if (lc !== 'self' && lc !== 'static' && lc !== 'parent') { const s = n.cls; return () => s; }
    }
    if (typeof n.cls !== 'string') {
      const E = cExpr(n.cls);
      return (f) => { const v = E(f); if (v instanceof PHPObject) return v.cls.name; throwError('TypeError', `Cannot use "::class" on ${typeOf(v)}`); };
    }
    const C = cClassRef(n.cls);
    return (f) => C(f).name;
  },
  Assign(n) {
    if (n.t.k === 'List') {
      const T = cLval(n.t);
      if (T.hasRef) {
        const S = cLval(n.e);
        return (f) => { const v = S.get(f); T.listAssign(f, v, S); return v; };
      }
      const E = cExpr(n.e);
      return (f) => { const v = E(f); T.listAssign(f, v, null); return v; };
    }
    const T = cLval(n.t);
    const E = cValue(n.e);
    // PHP evaluates dims and property names that are expressions before the assigned value
    if ((n.t.k === 'Index' || n.t.k === 'Prop' || n.t.k === 'SProp') && T.place && ((!isPureExpr(n.e) && !isSimpleTarget(n.t)) || hasImpureDims(n.t))) {
      return (f) => { const p = T.place(f); const v = E(f); const r = p.set(f, v); return r === undefined ? v : r; };
    }
    if (n.t.k === 'VarVar') {
      return (f) => { const p = T.place(f); const v = E(f); p.set(f, v); return v; };
    }
    if (n.t.k === 'Var' && typeof n.t.name === 'string' && n.t.name !== 'this' && n.t.name !== 'GLOBALS' && !SUPERGLOBALS.has(n.t.name)) {
      const name = n.t.name;
      return (f) => {
        const v = E(f); const r = f.vars[name];
        if (r !== undefined) { const old = r.v; r.v = v; if (old !== v && old !== null && typeof old === 'object') { dropRef(old); if (old instanceof PHPObject && old.cls.hasDestructor) gcCheck(old); } }
        else f.vars[name] = new Ref(v);
        return v;
      };
    }
    if (n.t.k === 'Index') return (f) => { const v = E(f); const r = T.set(f, v); return r === undefined ? v : r; };
    return (f) => { const v = E(f); T.set(f, v); return v; };
  },
  AssignRef(n) {
    const T = cLval(n.t);
    if (!isLvalNode(n.e)) {
      const E = cExpr(n.e);
      const isCallNode = n.e.k === 'Call' || n.e.k === 'MCall' || n.e.k === 'SCall';
      return (f) => {
        rt.lastRetRef = null;
        const v = E(f);
        const r = rt.lastRetRef; rt.lastRetRef = null;
        if (r !== null && r !== NOREF && r.v === v) { T.bind(f, r); return v; }
        if (isCallNode && r !== NOREF) notice('Only variables should be assigned by reference');
        T.set(f, cp(v)); return v;
      };
    }
    const S = cLval(n.e);
    return (f) => { const r = S.ref(f); T.bind(f, r); return r.v; };
  },
  AssignOp(n) {
    const T = cLval(n.t);
    const E = cExpr(n.e);
    const op = n.op;
    if (op === '??') {
      if (T.place && !isSimpleTarget(n.t)) {
        return (f) => {
          const p = T.place(f);
          const cur = p.getq(f);
          if (cur !== undefined && cur !== null) return cur;
          const v = cp(E(f));
          p.set(f, v);
          return v;
        };
      }
      return (f) => {
        const cur = T.getq(f);
        if (cur !== undefined && cur !== null) return cur;
        const v = cp(E(f));
        T.set(f, v);
        return v;
      };
    }
    const fnop = BINOPS[op];
    // PHP evaluates dims and property names that are expressions before the assigned value
    if ((n.t.k === 'Index' || n.t.k === 'Prop' || n.t.k === 'SProp') && T.place && ((!isPureExpr(n.e) && !isSimpleTarget(n.t)) || hasImpureDims(n.t))) {
      return (f) => { const p = T.place(f); const v = E(f); return p.modify(f, (cur) => fnop(cur, v)); };
    }
    if (op === '.' && n.t.k === 'Var' && typeof n.t.name === 'string' && n.t.name !== 'this' && !SUPERGLOBALS.has(n.t.name) && n.t.name !== 'GLOBALS') {
      const name = n.t.name;
      return (f) => {
        const v = E(f);
        let r = f.vars[name];
        if (r === undefined) { warnUndefVar(name); r = f.vars[name] = new Ref(''); }
        const cur = r.v;
        return (r.v = (typeof cur === 'string' ? cur : toStr(cur)) + (typeof v === 'string' ? v : toStr(v)));
      };
    }
    return (f) => { const v = E(f); return T.modify(f, (cur) => fnop(cur, v)); };
  },
  PreInc(n) { const T = cLval(n.e); return (f) => T.modify(f, inc); },
  PreDec(n) { const T = cLval(n.e); return (f) => T.modify(f, dec); },
  PostInc(n) {
    if (n.e.k === 'Var' && typeof n.e.name === 'string' && n.e.name !== 'this' && !SUPERGLOBALS.has(n.e.name)) {
      const name = n.e.name;
      return (f) => {
        const r = f.vars[name];
        if (r !== undefined) { const v = r.v; if (typeof v === 'number' && v < MAXS) { r.v = v + 1; return v; } r.v = inc(v); return v; }
        warnUndefVar(name); f.vars[name] = new Ref(1); return null;
      };
    }
    const T = cLval(n.e);
    return (f) => { let old; T.modify(f, (c) => { old = c; return inc(c); }); return old; };
  },
  PostDec(n) {
    const T = cLval(n.e);
    return (f) => { let old; T.modify(f, (c) => { old = c; return dec(c); }); return old; };
  },
  Bin(n) {
    const op = n.op;
    const A = cExpr(n.a), B = cExpr(n.b);
    if (n.a.k === 'Var' && typeof n.a.name === 'string' && n.a.name !== 'this' && !isPureExpr(n.b)) {
      // PHP reads compiled-variable operands when the operator executes, i.e. after the right operand
      const fnop = BINOPS[op];
      return (f) => { const b = B(f); return fnop(A(f), b); };
    }
    // constant folding for pure literal operands
    if (n.a.k === 'Lit' && n.b.k === 'Lit' && ['.', '+', '-', '*', '|', '&', '<<', '>>'].includes(op) && (isNum(n.a.v) || typeof n.a.v === 'string') && (isNum(n.b.v) || typeof n.b.v === 'string')) {
      if (op === '.' || (isNum(n.a.v) && isNum(n.b.v))) { const v = BINOPS[op](n.a.v, n.b.v); return () => v; }
    }
    switch (op) {
      case '+': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') { const r = a + b; if (r <= MAXS && r >= -MAXS) return r; } return add(a, b); };
      case '-': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') { const r = a - b; if (r <= MAXS && r >= -MAXS) return r; } return sub(a, b); };
      case '*': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') { const r = a * b; if (r <= MAXS && r >= -MAXS) return r === 0 ? 0 : r; } return mul(a, b); };
      case '.': return (f) => { const a = A(f), b = B(f); return (typeof a === 'string' ? a : toStr(a)) + (typeof b === 'string' ? b : toStr(b)); };
      case '<': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a < b; return lt(a, b); };
      case '>': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a > b; return lt(b, a); };
      case '<=': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a <= b; return le(a, b); };
      case '>=': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a >= b; return le(b, a); };
      case '==': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a === b; return looseEq(a, b); };
      case '!=': return (f) => { const a = A(f), b = B(f); if (typeof a === 'number' && typeof b === 'number') return a !== b; return !looseEq(a, b); };
      case '===': return (f) => { const a = A(f), b = B(f); if (a === b && !(a instanceof Flt)) return true; return strictEq(a, b); };
      case '!==': return (f) => { const a = A(f), b = B(f); if (a === b && !(a instanceof Flt)) return false; return !strictEq(a, b); };
    }
    const fnop = BINOPS[op];
    if (!fnop) throw new FatalSig(`Unknown operator ${op}`, n.l);
    return (f) => { const a = A(f); return fnop(a, B(f)); };
  },
  And(n) { const A = cExpr(n.a), B = cExpr(n.b); return (f) => toBool(A(f)) && toBool(B(f)); },
  Or(n) { const A = cExpr(n.a), B = cExpr(n.b); return (f) => toBool(A(f)) || toBool(B(f)); },
  Xor(n) { const A = cExpr(n.a), B = cExpr(n.b); return (f) => toBool(A(f)) !== toBool(B(f)); },
  Not(n) { const A = cExpr(n.e); return (f) => !toBool(A(f)); },
  Neg(n) { const A = cExpr(n.e); return (f) => { const v = A(f); if (typeof v === 'number') return v === 0 ? 0 : -v; if (v instanceof Flt) return mkf(-v.v); return mul(v, -1); }; },
  Plus(n) { const A = cExpr(n.e); return (f) => { const v = A(f); if (isNum(v)) return v; return mul(v, 1); }; },
  BitNot(n) { const A = cExpr(n.e); return (f) => bitNot(A(f)); },
  Silence(n) {
    const A = cExpr(n.e);
    return (f) => { rt.silence++; try { return A(f); } finally { rt.silence--; } };
  },
  Coalesce(n) {
    const A = isLvalNode(n.a) ? cLval(n.a).getq : cExpr(n.a);
    const B = cExpr(n.b);
    return (f) => { const v = A(f); return v === undefined || v === null ? B(f) : v; };
  },
  Ternary(n) {
    const C = cExpr(n.c), B = cExpr(n.b);
    if (!n.a) return (f) => { const v = C(f); return toBool(v) ? v : B(f); };
    const A = cExpr(n.a);
    return (f) => (toBool(C(f)) ? A(f) : B(f));
  },
  Cast(n) {
    const A = cExpr(n.e);
    switch (n.t) {
      case 'int': return (f) => toInt(A(f));
      case 'float': return (f) => mkf(toDbl(A(f)));
      case 'string': return (f) => toStr(A(f));
      case 'bool': return (f) => toBool(A(f));
      case 'array': return (f) => toArrayCast(A(f));
      case 'object': return (f) => toObjectCast(A(f));
      case 'unset': return (f) => { A(f); return null; };
    }
  },
  Isset(n) {
    const items = n.list.map((e) => (isLvalNode(e) ? (() => { const lv = cLval(e); return lv.isset || lv.getq; })() : (() => { throw new FatalSig('Cannot use isset() on the result of an expression (you can use "null !== expression" instead)', n.l); })()));
    return (f) => { for (let i = 0; i < items.length; i++) { const v = items[i](f); if (v === undefined || v === null) return false; } return true; };
  },
  Empty(n) {
    const A = isLvalNode(n.e) ? cLval(n.e).getq : cExpr(n.e);
    return (f) => { const v = A(f); return v === undefined || !toBool(v); };
  },
  Instanceof(n) {
    const E = cExpr(n.e);
    if (typeof n.cls === 'string') {
      const lc = n.cls.toLowerCase();
      if (lc === 'self' || lc === 'static' || lc === 'parent') {
        const C = cClassRef(n.cls);
        return (f) => { const v = E(f); return v instanceof PHPObject && v.cls.ancestors.has(C(f).lname); };
      }
      return (f) => { const v = E(f); return v instanceof PHPObject && v.cls.ancestors.has(lc); };
    }
    const C = cExpr(n.cls);
    return (f) => {
      const v = E(f), c = C(f);
      if (!(v instanceof PHPObject)) return false;
      if (c instanceof PHPObject) return v.cls.ancestors.has(c.cls.lname);
      if (typeof c === 'string') return v.cls.ancestors.has((c[0] === '\\' ? c.slice(1) : c).toLowerCase());
      throwError('Error', 'Class name must be a valid object or a string');
    };
  },
  Clone(n) {
    const E = cExpr(n.e);
    return (f) => cloneObject(E(f), f);
  },
  Print(n) { const E = cExpr(n.e); return (f) => { rt.echo(toStr(E(f))); return 1; }; },
  Exit(n) {
    const E = n.e ? cExpr(n.e) : null;
    return (f) => {
      const v = E ? E(f) : null;
      if (typeof v === 'string') { rt.echo(v); throw new ExitSig(0); }
      throw new ExitSig(v === null ? 0 : toInt(v));
    };
  },
  Throw(n) {
    const E = cExpr(n.e);
    return (f) => {
      const v = E(f);
      if (!(v instanceof PHPObject) || !v.cls.ancestors.has('throwable')) throwError('Error', 'Can only throw objects');
      throw new ThrowSig(v);
    };
  },
  Include(n) {
    const E = cExpr(n.e);
    const kind = n.kind;
    return (f) => doInclude(toStr(E(f)), kind, f);
  },
  Yield() { return () => { throw new FatalSig('Internal error: yield outside generator context'); }; },
  YieldFrom() { return () => { throw new FatalSig('Internal error: yield outside generator context'); }; },
  Match(n) {
    const E = cExpr(n.e);
    const arms = n.arms.map((a) => ({ conds: a.conds ? a.conds.map(cExpr) : null, body: cExpr(a.body) }));
    return (f) => {
      const v = E(f);
      let def = null;
      for (const arm of arms) {
        if (!arm.conds) { def = arm; continue; }
        for (const c of arm.conds) if (strictEq(v, c(f))) return arm.body(f);
      }
      if (def) return def.body(f);
      throwError('UnhandledMatchError', `Unhandled match case ${matchRepr(v)}`);
    };
  },
  Closure(n) {
    const fnObj = compileFunction(n.fn);
    if (n.fn.arrow) {
      const free = arrowFreeVars(n.fn);
      return (f) => {
        const bound = new Map();
        for (const name of free) { const r = f.vars[name]; if (r !== undefined) bound.set(name, cp(r.v)); }
        return makeClosure(fnObj, bound, n.fn.static ? null : f.this, f.cls, f.sc);
      };
    }
    const uses = n.fn.uses || [];
    return (f) => {
      const bound = new Map();
      for (const u of uses) {
        if (u.byRef) bound.set(u.name, f.vars[u.name] || (f.vars[u.name] = new Ref(null)));
        else { const r = f.vars[u.name]; if (r === undefined) { warnUndefVar(u.name); bound.set(u.name, null); } else bound.set(u.name, cp(r.v)); }
      }
      return makeClosure(fnObj, bound, n.fn.static ? null : f.this, f.cls, f.sc);
    };
  },
  New(n) {
    const A = n.args === 'fcc' ? null : compileArgs(n.args);
    if (n.cls && typeof n.cls === 'object' && n.cls.k === 'ClassDecl') {
      const decl = n.cls;
      let cls = null;
      return (f) => {
        if (!cls) cls = declareClass(decl, f);
        return instantiate(cls, A, f);
      };
    }
    const C = cClassRef(n.cls);
    return (f) => instantiate(C(f), A, f);
  },
  Call(n) {
    if (typeof n.f === 'string') return compileNamedCall(n);
    const F = cExpr(n.f);
    if (n.args === 'fcc') return (f) => callableToClosure(F(f), f);
    const A = compileArgs(n.args);
    const call = deferCalls ? deferredCall : callFunction;
    return (f) => {
      const callee = F(f);
      const c = resolveCallable(callee, f, true);
      const args = A(f, c.fn);
      return call(c.fn, args, c.thisObj, c.cls, c.sc, c.closure);
    };
  },
  MCall(n) {
    const O = cExpr(n.o);
    const N = typeof n.name === 'string' ? null : cExpr(n.name);
    const sname = typeof n.name === 'string' ? n.name : null;
    const lname = sname ? sname.toLowerCase() : null;
    const nullsafe = n.nullsafe;
    if (n.args === 'fcc') {
      return (f) => {
        const o = O(f);
        const name = sname || toStr(N(f));
        if (!(o instanceof PHPObject)) throwError('Error', `Call to a member function ${name}() on ${typeOf(o)}`);
        return methodClosure(o, name, f);
      };
    }
    const A = compileArgs(n.args);
    const call = deferCalls ? deferredCall : callFunction;
    return (f) => {
      const o = O(f);
      if (!(o instanceof PHPObject)) {
        if (nullsafe && (o === null || o === undefined)) return null;
        let name = sname;
        if (!name) { const nv = N(f); name = typeof nv === 'string' ? nv : '{closure}'; }
        throwError('Error', `Call to a member function ${name}() on ${typeOf(o)}`);
      }
      let name = sname, ln = lname;
      if (!name) {
        const nv = N(f);
        if (nv instanceof PHPObject) { const c = resolveCallable(nv, f, true); return call(c.fn, A(f, c.fn), c.thisObj, c.cls, c.sc, c.closure); }
        name = toStr(nv); ln = name.toLowerCase();
      }
      let m;
      const scope = f.cls;
      if (scope !== null && scope.privMethods !== null) { const pm = scope.privMethods.get(ln); if (pm !== undefined && o.cls.ancestors.has(scope.lname)) m = pm; }
      if (m === undefined) m = o.cls.methods.get(ln);
      if (m !== undefined && (m.vis === 'public' || canAccessMember(m, f.cls))) {
        const args = A(f, m.fn);
        if (m.static) return call(m.fn, args, null, m.cls, o.cls, null);
        return call(m.fn, args, o, m.cls, o.cls, null);
      }
      // closure stored in property is not a method; __call fallback
      if (o.cls === closureClass && (ln === 'call' || ln === '__invoke' || ln === 'bindto' || ln === 'bind')) {
        const cm = o.cls.methods.get(ln);
        return callFunction(cm.fn, A(f, cm.fn), o, o.cls, o.cls, null);
      }
      const magic = o.cls.methods.get('__call');
      if (magic) {
        const args = A(f, null);
        return call(magic.fn, [name, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], o, magic.cls, o.cls, null);
      }
      if (m !== undefined) throwError('Error', `Call to ${m.vis} method ${o.cls.name}::${m.name}() from ${f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
      throwError('Error', `Call to undefined method ${o.cls.name}::${name}()`);
    };
  },
  SCall(n) {
    const C = cClassRef(n.cls);
    const N = typeof n.name === 'string' ? null : cExpr(n.name);
    const sname = typeof n.name === 'string' ? n.name : null;
    const isRel = typeof n.cls === 'string' && ['self', 'parent', 'static'].includes(n.cls.toLowerCase());
    const isParent = typeof n.cls === 'string' && n.cls.toLowerCase() === 'parent';
    const isSelf = typeof n.cls === 'string' && n.cls.toLowerCase() === 'self';
    if (n.args === 'fcc') {
      return (f) => {
        const cls = C(f);
        const name = sname || toStr(N(f));
        const m = findMethod(cls, name);
        if (!m) throwError('Error', `Call to undefined method ${cls.name}::${name}()`);
        const thisObj = !m.static && f.this && f.this.cls.ancestors.has(cls.lname) ? f.this : null;
        return makeClosure(m.fn, null, thisObj, m.cls, (isRel && !isParent && !isSelf) ? cls : (thisObj ? thisObj.cls : (isRel ? f.sc : cls)), null);
      };
    }
    const A = compileArgs(n.args);
    const call = deferCalls ? deferredCall : callFunction;
    return (f) => {
      const cls = C(f);
      const name = sname || toStr(N(f));
      const m = cls.methods.get(name.toLowerCase());
      if (!m || (m.vis !== 'public' && !canAccessMember(m, f.cls))) {
        // __callStatic / __call
        if (f.this && f.this.cls.ancestors.has(cls.lname)) {
          const mc = cls.methods.get('__call');
          if (mc) { const args = A(f, null); return call(mc.fn, [name, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], f.this, mc.cls, f.this.cls, null); }
        }
        const ms = cls.methods.get('__callstatic');
        if (ms) { const args = A(f, null); return call(ms.fn, [name, PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)))], null, ms.cls, cls, null); }
        if (m) throwError('Error', `Call to ${m.vis} method ${cls.name}::${m.name}() from ${f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
        throwError('Error', `Call to undefined method ${cls.name}::${name}()`);
      }
      if (m.abstract) throwError('Error', `Cannot call abstract method ${m.cls.name}::${m.name}()`);
      const args = A(f, m.fn);
      if (m.static) {
        const sc = isRel && (isParent || isSelf) ? (f.sc || cls) : cls;
        return call(m.fn, args, null, m.cls, sc, null);
      }
      if (f.this && f.this.cls.ancestors.has(cls.lname)) return call(m.fn, args, f.this, m.cls, f.this.cls, null);
      throwError('Error', `Non-static method ${cls.name}::${m.name}() cannot be called statically`);
    };
  },
};

// target whose sub-expressions are literals / plain variables that the RHS cannot change
function hasImpureDims(t) {
  switch (t.k) {
    case 'Index': return (t.i !== null && !isPureExpr(t.i)) || hasImpureDims(t.o);
    case 'Prop': return (typeof t.name === 'object' && !isPureExpr(t.name)) || hasImpureDims(t.o);
  }
  return false;
}
function isSimpleTarget(t) {
  switch (t.k) {
    case 'Var': return typeof t.name === 'string';
    case 'Index': return isSimpleTarget(t.o) && (t.i === null || t.i.k === 'Lit');
    case 'Prop': return isSimpleTarget(t.o) && typeof t.name === 'string';
    case 'SProp': return typeof t.cls === 'string' && typeof t.name === 'string';
  }
  return false;
}
function isPureExpr(n) {
  if (!n || typeof n !== 'object') return true;
  switch (n.k) {
    case 'Lit': case 'Var': case 'Const': case 'CConst': case 'ClassName': case 'MagicClass': return true;
    case 'Bin': return isPureExpr(n.a) && isPureExpr(n.b);
    case 'Not': case 'Neg': case 'Plus': case 'BitNot': case 'Cast': return isPureExpr(n.e);
    case 'Interp': return n.parts.every((p) => typeof p === 'string' || isPureExpr(p));
    case 'Index': return isPureExpr(n.o) && (n.i === null || isPureExpr(n.i));
    case 'Arr': return n.items.every((it) => !it || (isPureExpr(it.v) && (!it.key || isPureExpr(it.key))));
    case 'Ternary': return isPureExpr(n.c) && (!n.a || isPureExpr(n.a)) && isPureExpr(n.b);
    case 'And': case 'Or': case 'Xor': case 'Coalesce': return isPureExpr(n.a) && isPureExpr(n.b);
    case 'Isset': return n.list.every(isPureExpr);
    case 'Empty': return isPureExpr(n.e);
  }
  return false;
}
export function matchRepr(v) {
  if (typeof v === 'string') { const max = 15; return "'" + (v.length > max ? v.slice(0, max) + '...' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
  if (v instanceof PHPObject) return 'of type ' + v.cls.name;
  if (v instanceof PHPArray) return 'of type array';
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Flt) return fmtReprZ(v.v);
  return toStr(v);
}

function lt(a, b) {
  if (a instanceof Flt && b instanceof Flt) return a.v < b.v;
  if (a instanceof Flt && typeof b === 'number') return a.v < b;
  if (typeof a === 'number' && b instanceof Flt) return a < b.v;
  if ((a instanceof Flt && a.v !== a.v) || (b instanceof Flt && b.v !== b.v)) return false;
  return cmp(a, b) < 0;
}
function le(a, b) {
  if (a instanceof Flt && b instanceof Flt) return a.v <= b.v;
  if (a instanceof Flt && typeof b === 'number') return a.v <= b;
  if (typeof a === 'number' && b instanceof Flt) return a <= b.v;
  if ((a instanceof Flt && a.v !== a.v) || (b instanceof Flt && b.v !== b.v)) return false;
  return cmp(a, b) <= 0;
}

const BINOPS = {
  '+': add, '-': sub, '*': mul, '/': div, '%': mod, '**': pow, '.': concat,
  '&': bitAnd, '|': bitOr, '^': bitXor, '<<': shl, '>>': shr,
  '==': looseEq, '!=': (a, b) => !looseEq(a, b), '===': strictEq, '!==': (a, b) => !strictEq(a, b),
  '<': lt, '>': (a, b) => lt(b, a), '<=': le, '>=': (a, b) => le(b, a), '<=>': cmp,
};

function spreadInto(a, v) {
  if (v instanceof PHPArray) {
    for (const [k, x] of v.entries()) { if (typeof k === 'string') a.set(k, cp(x)); else a.push(cp(x)); }
    return;
  }
  if (v instanceof PHPObject && v.cls.ancestors.has('traversable')) {
    iterateObject(v, (k, x) => { if (typeof k === 'string') a.set(k, cp(x)); else a.push(cp(x)); });
    return;
  }
  throwError('Error', 'Only arrays and Traversables can be unpacked');
}

// ---------------------------------------------------------------- arguments
export function isRefParam(fn, i) {
  if (!fn) return false;
  const r = fn.refs;
  if (r === null || r === undefined) return false;
  if (i < r.length) return r[i];
  return fn.refRest !== undefined && fn.refRest !== null && i >= fn.refRest;
}
function compileArgs(argNodes) {
  if (argNodes.length === 0) return () => [];
  const items = argNodes.map((a) => {
    const E = cExpr(a.e);
    let L = isLvalNode(a.e) ? cLval(a.e) : null;
    // f($b =& $a) passes the reference that was just made
    if (!L && a.e.k === 'AssignRef' && isLvalNode(a.e.t)) { const T = cLval(a.e.t); L = { ref: (f) => { E(f); return T.ref(f); } }; }
    return { E, L, spread: !!a.spread, name: a.name || null, tempRef: !L && ['Call', 'MCall', 'SCall', 'New', 'Include', 'Eval'].includes(a.e.k) };
  });
  const simple = items.every((it) => !it.spread && !it.name);
  if (simple) {
    const n = items.length;
    return (f, fn) => {
      const out = new Array(n);
      const refs = fn ? fn.refs : null;
      for (let i = 0; i < n; i++) {
        const it = items[i];
        if (refs && isRefParam(fn, i)) {
          if (it.L) out[i] = it.L.ref(f);
          else {
            rt.lastRetRef = null;
            const v = it.E(f);
            const rr = rt.lastRetRef; rt.lastRetRef = null;
            if (rr !== null && rr !== NOREF && rr.v === v) { out[i] = rr; continue; }
            if (rr === NOREF) { out[i] = new Ref(v); continue; }
            if (!it.tempRef) { const pn = fn.params ? (fn.params[i] && fn.params[i].name) : (fn.pnames && fn.pnames[i]); throwError('Error', `${fnDisplayName(fn)}(): Argument #${i + 1}${pn ? ' ($' + pn + ')' : ''} could not be passed by reference`); }
            notice('Only variables should be passed by reference');
            out[i] = new Ref(v);
          }
        } else out[i] = it.E(f);
      }
      return out;
    };
  }
  return (f, fn) => {
    const out = [];
    let named = null;
    for (const it of items) {
      if (it.spread) {
        let v = it.E(f);
        if (v instanceof PHPArray && it.L && fn && fn.refs) {
          // unpacking into by-reference parameters binds the array elements
          const arr = it.L.arr(f);
          for (let i = 0; i < arr.k.length; i++) {
            const k = arr.k[i]; if (k === undefined) continue;
            if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, deref(arr.v[i])); continue; }
            if (isRefParam(fn, out.length)) { let slot = arr.v[i]; if (!(slot instanceof Ref)) { slot = new Ref(slot); arr.v[i] = slot; } out.push(slot); }
            else out.push(deref(arr.v[i]));
          }
          continue;
        }
        if (v instanceof PHPArray) {
          for (const [k, x] of v.entries()) {
            if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, x); }
            else { if (named) throwError('Error', 'Cannot use positional argument after named argument during unpacking'); out.push(x); }
          }
        } else if (v instanceof PHPObject && v.cls.ancestors.has('traversable')) {
          iterateObject(v, (k, x) => {
            if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, x); }
            else if (isInt(k)) { if (named) throwError('Error', 'Cannot use positional argument after named argument during unpacking'); out.push(x); }
            else throwError('Error', 'Keys must be of type int|string during argument unpacking');
          });
        } else throwError('Error', 'Only arrays and Traversables can be unpacked');
        continue;
      }
      if (it.name) {
        if (!named) named = new Map();
        if (named.has(it.name)) throwError('Error', `Named parameter $${it.name} overwrites previous argument`);
        let pi = -1;
        if (fn && fn.params) pi = fn.params.findIndex((p) => p.name === it.name);
        if (pi >= 0 && isRefParam(fn, pi) && it.L) named.set(it.name, it.L.ref(f));
        else named.set(it.name, it.E(f));
        continue;
      }
      if (named) throwError('Error', 'Cannot use positional argument after named argument');
      const i = out.length;
      if (isRefParam(fn, i)) out.push(it.L ? it.L.ref(f) : new Ref(it.E(f)));
      else out.push(it.E(f));
    }
    if (named) out.named = named;
    return out;
  };
}

function compileNamedCall(n, plain) {
  const name = n.f, fb = n.fb;
  const lname = name.toLowerCase(), lfb = fb ? fb.toLowerCase() : null;
  // assert(): unless zend.assertions=1 the call (and its arguments) is skipped
  if ((lfb || lname) === 'assert' && n.args !== 'fcc' && !plain) {
    const inner = compileNamedCall(n, true);
    return (f) => (rt.ini.get('zend.assertions') === '1' ? inner(f) : true);
  }
  // compile-time special forms that need the caller's frame
  const special = FRAME_FUNCS[lfb || lname];
  if (special) {
    const A = n.args === 'fcc' ? null : compileArgs(n.args);
    return (f) => special(f, A ? A(f, null) : []);
  }
  if (n.args === 'fcc') {
    return (f) => {
      const fn = rt.fns.get(lname) || (lfb && rt.fns.get(lfb));
      if (!fn) throwError('Error', `Call to undefined function ${name}()`);
      return makeClosure(fn, null, null, null, null);
    };
  }
  const A = compileArgs(n.args);
  const call = deferCalls ? deferredCall : callFunction;
  // the resolved function is cached per call site; rt.epoch changes on every run, since compiled
  // code (includes, eval) is reused across runs but function tables are not
  let cached = null, cachedEpoch = -1;
  return (f) => {
    let fn = cached;
    if (cachedEpoch !== rt.epoch) {
      fn = rt.fns.get(lname);
      if (fn === undefined && lfb) fn = rt.fns.get(lfb);
      if (fn === undefined) fn = lazyFn(lfb || lname);
      if (fn === undefined) { const sp = FRAME_FUNCS[lfb || lname]; if (sp) return sp(f, A(f, null)); throwError('Error', `Call to undefined function ${fb || name}()`); }
      cached = fn; cachedEpoch = rt.epoch;
    }
    const args = A(f, fn);
    if (fn.native) return callNative(fn, args);
    return call(fn, args, null, null, null, null);
  };
}
