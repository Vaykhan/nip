// Generator-mode compilation: bodies of functions containing yield become JS generator functions.

import { cp, PHPArray, PHPObject, Ref, ThrowSig } from '../values.js';
import { toBool, toStr } from '../convert.js';
import { looseEq, strictEq } from '../compare.js';
import { hasYield, isLvalNode, mkBreak, mkCont, RETURN } from './common.js';
import { cLval } from './lvalue.js';
import { cExpr, matchRepr } from './expr.js';
import { cStmt, GOTO, gotoTargets, iterateObject } from './stmt.js';
import { rt } from '../runtime/state.js';
import { throwError, toThrowSig, warn } from '../runtime/errors.js';
import { valueName } from '../runtime/functions.js';
import { callMethodName } from '../runtime/classes.js';
import { GenThrow } from '../runtime/generators.js';
import { generatorClass } from '../runtime/native-classes.js';

// wraps a non-yielding body so it can be driven like a generator
function genWrap(fn) {
  const g = function* (f) { return fn(f); };
  if (fn.labels) { g.labels = fn.labels; g.enter = function* (f, label) { return fn.enter(f, label); }; }
  return g;
}

function cExprG(n) {
  if (!hasYield(n)) return genWrap(cExpr(n));
  switch (n.k) {
    case 'Yield': {
      const K = n.key ? cExprG(n.key) : null;
      const V = n.v ? cExprG(n.v) : null;
      const Lv = n.v && isLvalNode(n.v) && !hasYield(n.v) ? cLval(n.v) : null;
      return function* (f) {
        const k = K ? yield* K(f) : undefined;
        let v = null, ref = null;
        if (V) {
          if (Lv && f.fn && f.fn.byRef) { ref = Lv.ref(f); v = ref.v; }
          else v = cp(yield* V(f));
        }
        const sent = yield [k, v, false, ref];
        if (sent instanceof GenThrow) throw new ThrowSig(sent.obj);
        return sent === undefined ? null : sent;
      };
    }
    case 'YieldFrom': {
      const E = cExprG(n.e);
      return function* (f) {
        const src = yield* E(f);
        if (src instanceof PHPArray) {
          for (const [k, v] of src.entries()) yield [k, v, true];
          return null;
        }
        if (src instanceof PHPObject && src.cls === generatorClass) {
          const g = src.gen;
          if (g.done) return g.ret;
          g.ensure(true);
          while (!g.done) {
            const sent = yield [g.key, g.cur, true];
            if (sent instanceof GenThrow) g.throwIn(sent.obj); else g.send(sent === undefined ? null : sent);
          }
          return g.ret;
        }
        if (src instanceof PHPObject && src.cls.ancestors.has('traversable')) {
          const pairs = []; iterateObject(src, (k, v) => { pairs.push([k, v]); });
          for (const [k, v] of pairs) yield [k, v, true];
          return null;
        }
        throwError('Error', 'Can use "yield from" only with arrays and Traversables');
      };
    }
    case 'Ternary': {
      const C = cExprG(n.c), A = n.a ? cExprG(n.a) : null, B = cExprG(n.b);
      return function* (f) { const c = yield* C(f); if (toBool(c)) return A ? yield* A(f) : c; return yield* B(f); };
    }
    case 'And': { const A = cExprG(n.a), B = cExprG(n.b); return function* (f) { return toBool(yield* A(f)) && toBool(yield* B(f)); }; }
    case 'Or': { const A = cExprG(n.a), B = cExprG(n.b); return function* (f) { return toBool(yield* A(f)) || toBool(yield* B(f)); }; }
    case 'Coalesce': {
      const A = isLvalNode(n.a) && !hasYield(n.a) ? genWrap(cLval(n.a).getq) : cExprG(n.a);
      const B = cExprG(n.b);
      return function* (f) { const v = yield* A(f); return v === undefined || v === null ? yield* B(f) : v; };
    }
    case 'Match': {
      const E = cExprG(n.e);
      const arms = n.arms.map((a) => ({ conds: a.conds ? a.conds.map(cExprG) : null, body: cExprG(a.body) }));
      return function* (f) {
        const v = yield* E(f);
        let def = null;
        for (const arm of arms) {
          if (!arm.conds) { def = arm; continue; }
          for (const c of arm.conds) if (strictEq(v, yield* c(f))) return yield* arm.body(f);
        }
        if (def) return yield* def.body(f);
        throwError('UnhandledMatchError', `Unhandled match case ${matchRepr(v)}`);
      };
    }
  }
  // generic: hoist yield-containing sub-expressions into temporaries
  const hoisted = [];
  let tempId = 0;
  const replace = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(replace);
    if (!hasYield(node)) return node;
    if (['Yield', 'YieldFrom', 'Ternary', 'And', 'Or', 'Coalesce', 'Match'].includes(node.k)) {
      const id = 't' + (genTempCounter++) + '_' + (tempId++);
      hoisted.push({ id, G: cExprG(node) });
      return { k: 'Temp', id, l: node.l };
    }
    const copy = {};
    for (const key in node) { if (key === '_hy') continue; copy[key] = (key === 'l' || key === 'k') ? node[key] : replace(node[key]); }
    copy._hy = false;
    return copy;
  };
  const replaced = replace(n);
  const E = cExpr(replaced);
  return function* (f) {
    if (!f.temps) f.temps = Object.create(null);
    for (const h of hoisted) f.temps[h.id] = yield* h.G(f);
    return E(f);
  };
}
let genTempCounter = 0;

export function cStmtsG(list) {
  const fns = [], nodes = [];
  for (const s of list) { const c = cStmtG(s); if (c) { fns.push(c); nodes.push(s); } }
  const targets = gotoTargets(fns, nodes);
  if (targets) return labelledStmtsG(fns, nodes, targets);
  return function* (f) {
    for (let i = 0; i < fns.length; i++) { const r = yield* fns[i](f); if (r !== undefined) return r; }
    return undefined;
  };
}
// generator-mode version of labelledStmts() in stmt.js
function labelledStmtsG(fns, nodes, targets) {
  const n = fns.length;
  const exec = function* (f, label) {
    let i = 0;
    for (;;) {
      let r;
      if (label !== null) {
        const j = targets.get(label);
        r = nodes[j].k === 'Label' ? undefined : yield* fns[j].enter(f, label);
        i = j + 1; label = null;
      } else {
        if (i >= n) return undefined;
        r = yield* fns[i++](f);
      }
      if (r !== undefined) {
        if (r.t === GOTO && targets.has(r.label)) { label = r.label; continue; }
        return r;
      }
    }
  };
  const run = function* (f) { return yield* exec(f, null); };
  run.labels = new Set(targets.keys());
  run.enter = exec;
  return run;
}
function exposeLabelsG(fn, parts, enter) {
  const labels = new Set();
  for (const p of parts) if (p && p.labels) for (const l of p.labels) labels.add(l);
  if (labels.size) { fn.labels = labels; fn.enter = enter; }
  return fn;
}
function cBodyG(n) { return n.k === 'Block' ? cStmtsG(n.body) : cStmtsG([n]); }

function cStmtG(n) {
  if (!n) return null;
  if (!hasYield(n)) { const s = cStmt(n); return s ? genWrap(s) : null; }
  const l = n.l;
  switch (n.k) {
    case 'Block': return cStmtsG(n.body);
    case 'Echo': {
      const args = n.args.map(cExprG);
      return function* (f) { rt.line = l; for (const a of args) rt.echo(toStr(yield* a(f))); };
    }
    case 'ExprStmt': { const E = cExprG(n.e); return function* (f) { rt.line = l; yield* E(f); }; }
    case 'Return': { const E = cExprG(n.e); return function* (f) { rt.line = l; f.ret = cp(yield* E(f)); return RETURN; }; }
    case 'If': {
      const conds = [cExprG(n.c), ...n.elifs.map((e) => cExprG(e.c))];
      const bodies = [cBodyG(n.then), ...n.elifs.map((e) => cBodyG(e.body))];
      const els = n.els ? cBodyG(n.els) : null;
      const parts = [...bodies, els];
      return exposeLabelsG(function* (f) {
        rt.line = l;
        for (let i = 0; i < conds.length; i++) if (toBool(yield* conds[i](f))) return yield* bodies[i](f);
        if (els) return yield* els(f);
      }, parts, function* (f, label) { return yield* parts.find((p) => p && p.labels && p.labels.has(label)).enter(f, label); });
    }
    case 'While': {
      const C = cExprG(n.c), B = cBodyG(n.body);
      return function* (f) {
        while (toBool(yield* C(f))) {
          const r = yield* B(f);
          if (r !== undefined) {
            if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
            if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
            return r;
          }
        }
      };
    }
    case 'DoWhile': {
      const C = cExprG(n.c), B = cBodyG(n.body);
      return function* (f) {
        do {
          const r = yield* B(f);
          if (r !== undefined) {
            if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
            if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
            return r;
          }
        } while (toBool(yield* C(f)));
      };
    }
    case 'For': {
      const init = n.init.map(cExprG), cond = n.cond.map(cExprG), step = n.step.map(cExprG), B = cBodyG(n.body);
      return function* (f) {
        for (const e of init) yield* e(f);
        for (;;) {
          let ok = true;
          for (let i = 0; i < cond.length; i++) { const v = yield* cond[i](f); if (i === cond.length - 1) ok = toBool(v); }
          if (!ok) break;
          const r = yield* B(f);
          if (r !== undefined) {
            if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
            if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); }
            else return r;
          }
          for (const e of step) yield* e(f);
        }
      };
    }
    case 'Foreach': {
      const E = cExprG(n.e);
      const LE = n.byRef ? cLval(n.e) : null;
      const K = n.kv ? cLval(n.kv) : null;
      const V = cLval(n.v);
      const isList = n.v.k === 'List';
      const B = cBodyG(n.body);
      return function* (f) {
        rt.line = l;
        let it;
        if (n.byRef) {
          const s0 = LE.getq(f);
          if (s0 instanceof PHPObject) it = objIterator(s0, f);
          else it = arrayRefIterator(LE.arr(f));
        } else {
          const subj = yield* E(f);
          if (subj instanceof PHPArray) it = arrayIterator(subj);
          else if (subj instanceof PHPObject) it = objIterator(subj, f);
          else { warn(`foreach() argument must be of type array|object, ${valueName(subj)} given`); return; }
        }
        try {
          while (it.next()) {
            if (n.byRef) V.bind(f, it.ref());
            else if (isList) V.listAssign(f, it.val, null);
            else V.set(f, cp(it.val));
            if (K) K.set(f, it.key);
            const r = yield* B(f);
            if (r !== undefined) {
              if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
              if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
              return r;
            }
          }
        } finally { it.done(); }
      };
    }
    case 'Switch': {
      const E = cExprG(n.e);
      const flat = [], flatNodes = []; const starts = []; let defIdx = -1;
      for (const c of n.cases) {
        starts.push({ T: c.test ? cExprG(c.test) : null, at: flat.length });
        if (!c.test) defIdx = starts.length - 1;
        for (const s of c.body) { const cs = cStmtG(s); if (cs) { flat.push(cs); flatNodes.push(s); } }
      }
      const targets = gotoTargets(flat, flatNodes);
      return function* (f) {
        const v = yield* E(f);
        let start = -1;
        for (const s of starts) if (s.T && looseEq(v, yield* s.T(f))) { start = s.at; break; }
        if (start < 0) { if (defIdx < 0) return; start = starts[defIdx].at; }
        for (let i = start; i < flat.length; i++) {
          let r = yield* flat[i](f);
          while (r !== undefined && r.t === GOTO && targets && targets.has(r.label)) {
            i = targets.get(r.label);
            r = flatNodes[i].k === 'Label' ? undefined : yield* flat[i].enter(f, r.label);
          }
          if (r !== undefined) {
            if (r.t === 1 || r.t === 2) { if (r.n > 1) return r.t === 1 ? mkBreak(r.n - 1) : mkCont(r.n - 1); return; }
            return r;
          }
        }
      };
    }
    case 'Try': {
      const B = cBodyG(n.body);
      const catches = n.catches.map((c) => ({ types: c.types.map((t) => t.toLowerCase()), v: c.v, B: cBodyG(c.body) }));
      const F = n.fin ? cBodyG(n.fin) : null;
      const run = function* (f, label) { // label: see the Try statement in stmt.js
        let res;
        try {
          const c = label === undefined ? null : catches.find((x) => x.B.labels && x.B.labels.has(label));
          if (c) {
            if (!F) return yield* c.B.enter(f, label);
            try { res = yield* c.B.enter(f, label); }
            finally { const fr = yield* F(f); if (fr !== undefined) return fr; } // eslint-disable-line no-unsafe-finally
            return res;
          }
          res = label === undefined ? yield* B(f) : yield* B.enter(f, label);
        } catch (e) {
          const sig = toThrowSig(e);
          if (!sig) throw e;
          const obj = sig.obj;
          for (const c of catches) {
            if (c.types.some((t) => obj.cls.ancestors.has(t))) {
              if (c.v) { const r = f.vars[c.v]; if (r) r.v = obj; else f.vars[c.v] = new Ref(obj); }
              if (F) {
                try { res = yield* c.B(f); }
                finally { const fr = yield* F(f); if (fr !== undefined) return fr; } // eslint-disable-line no-unsafe-finally
                return res;
              }
              return yield* c.B(f);
            }
          }
          if (F) { const fr = yield* F(f); if (fr !== undefined) return fr; }
          throw sig;
        }
        if (F) { const fr = yield* F(f); if (fr !== undefined) return fr; }
        return res;
      };
      return exposeLabelsG(function* (f) { return yield* run(f, undefined); }, [B, ...catches.map((c) => c.B)], run);
    }
  }
  // fallback: statements that only contain yields in expressions
  const s = cStmt(n);
  return genWrap(s);
}

function arrayIterator(a) {
  a.fe = (a.fe || 0) + 1;
  let i = -1;
  const it = {
    key: null, val: null,
    next() {
      for (i++; i < a.k.length; i++) {
        const k = a.k[i];
        if (k === undefined) continue;
        it.key = k; const v = a.v[i]; it.val = v instanceof Ref ? v.v : v; return true;
      }
      return false;
    },
    done() { a.fe--; },
  };
  return it;
}
function arrayRefIterator(a) {
  a.iters++;
  let i = -1;
  const it = {
    key: null,
    next() {
      for (i++; i < a.k.length; i++) { const k = a.k[i]; if (k === undefined) continue; it.key = k; return true; }
      return false;
    },
    ref() { let s = a.v[i]; if (!(s instanceof Ref)) { s = new Ref(s); a.v[i] = s; } return s; },
    done() { a.iters--; },
  };
  return it;
}
function objIterator(obj, f) {
  if (obj.cls === generatorClass) {
    const g = obj.gen; let first = true;
    const it = {
      key: null, val: null,
      next() { if (first) { g.ensure(true); first = false; } else g.next(); if (g.done) return false; it.key = g.key; it.val = g.cur; return true; },
      ref() { return g.curRef || new Ref(g.cur); },
      done() {},
    };
    return it;
  }
  if (obj.cls.ancestors.has('iterator')) {
    let first = true;
    const it = {
      key: null, val: null,
      next() {
        if (first) { callMethodName(obj, 'rewind', []); first = false; } else callMethodName(obj, 'next', []);
        if (!toBool(callMethodName(obj, 'valid', []))) return false;
        it.val = callMethodName(obj, 'current', []); it.key = callMethodName(obj, 'key', []); return true;
      },
      ref() { return new Ref(it.val); },
      done() {},
    };
    return it;
  }
  if (obj.cls.ancestors.has('iteratoraggregate')) return objIterator(callMethodName(obj, 'getIterator', []), f);
  const pairs = [];
  iterateObject(obj, (k, v) => { pairs.push([k, v]); });
  let i = -1;
  const it = {
    key: null, val: null,
    next() { i++; if (i >= pairs.length) return false; it.key = pairs[i][0]; it.val = pairs[i][1]; return true; },
    ref() { const k = String(it.key); let s = obj.props.get(k); if (!(s instanceof Ref)) { s = new Ref(s === undefined ? null : s); obj.props.set(k, s); } return s; },
    done() {},
  };
  return it;
}
