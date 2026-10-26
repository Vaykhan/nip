// Compilation of statements (control flow, declarations, foreach, try/catch, ...).

import { cp, FatalSig, NOREF, normKey, objHandles, PHPArray, PHPObject, Ref } from '../values.js';
import { toBool, toStr, valueName } from '../convert.js';
import { looseEq } from '../compare.js';
import { isLvalNode, mkBreak, mkCont, RETURN, SUPERGLOBALS } from './common.js';
import { cLval } from './lvalue.js';
import { cExpr, cValue } from './expr.js';
import { rt } from '../runtime/state.js';
import { checkTimeLimit, notice, throwError, toThrowSig, warn } from '../runtime/errors.js';
import { compilingByRef, declareFunction } from '../runtime/functions.js';
import { callMethodName, canAccessMember, declareClass, objectProps, propAccessible } from '../runtime/classes.js';
import { caughtTemps, dropRef, feSubjects, gcCheck, idq, idSafePoint } from '../runtime/gc.js';
import { callValue } from '../runtime/callables.js';
import { generatorClass } from '../runtime/native-classes.js';

export function cStmts(list) {
  const fns = [], nodes = [];
  for (const s of list) { const c = cStmt(s); if (c) { fns.push(c); nodes.push(s); } }
  const targets = gotoTargets(fns, nodes);
  if (targets) return labelledStmts(fns, nodes, targets);
  const n = fns.length;
  if (n === 0) return () => undefined;
  if (n === 1) return fns[0];
  if (n === 2) { const [a, b] = fns; return (f) => { const r = a(f); if (r !== undefined) return r; return b(f); }; }
  return (f) => {
    for (let i = 0; i < n; i++) { const r = fns[i](f); if (r !== undefined) return r; }
    return undefined;
  };
}
function cBody(n) { return n.k === 'Block' ? cStmts(n.body) : cStmts([n]); }

// goto support. A `goto` returns a GOTO signal that travels up like `break`. A statement list
// that contains the label (directly, or inside an if/else branch, block, try or catch body it
// can enter) resumes there. Compiled statements containing enterable labels carry `.labels` (a
// Set) and `.enter(f, label)`, which runs the statement starting at the label. Loops, switch
// and finally don't expose their labels: PHP rejects jumps into them at compile time.
export const GOTO = 4;
export function gotoTargets(fns, nodes) {
  let map = null;
  for (let i = 0; i < fns.length; i++) {
    const labels = nodes[i].k === 'Label' ? [nodes[i].name] : fns[i].labels;
    if (labels) for (const name of labels) (map || (map = new Map())).set(name, i);
  }
  return map;
}
function labelledStmts(fns, nodes, targets) {
  const n = fns.length;
  const exec = (f, label) => {
    let i = 0;
    for (;;) {
      let r;
      if (label !== null) {
        const j = targets.get(label);
        r = nodes[j].k === 'Label' ? undefined : fns[j].enter(f, label);
        i = j + 1; label = null;
      } else {
        if (i >= n) return undefined;
        r = fns[i++](f);
      }
      if (r !== undefined) {
        if (r.t === GOTO && targets.has(r.label)) { label = r.label; continue; }
        return r;
      }
    }
  };
  const run = (f) => exec(f, null);
  run.labels = new Set(targets.keys());
  run.enter = exec;
  return run;
}
// gives an if/try statement the labels of its enterable parts (each a compiled body or null)
function exposeLabels(fn, parts, enter) {
  const labels = new Set();
  for (const p of parts) if (p && p.labels) for (const l of p.labels) labels.add(l);
  if (labels.size) { fn.labels = labels; fn.enter = enter; }
  return fn;
}

export function cStmt(n) {
  if (!n) return null;
  const fn = STMT[n.k];
  if (!fn) throw new FatalSig(`Unsupported statement type ${n.k}`, n.l);
  const c = fn(n);
  return n.ticks ? withTick(c, n.ticks) : c;
}
// declare(ticks=N): run the tick functions after every N ticked statements
function withTick(c, every) {
  const t = (f) => { const r = c(f); tick(every); return r; };
  if (c.labels) { t.labels = c.labels; t.enter = (f, label) => { const r = c.enter(f, label); tick(every); return r; }; }
  return t;
}
export function tick(every) {
  if (++rt.tickCount < every) return; // counts even when no tick function is registered
  rt.tickCount = 0;
  for (const t of rt.tickFns.slice()) {
    if (t.calling) continue;
    t.calling = true;
    rt.fiberSwitchBlocked++; // nor can tick functions
    try { callValue(t.cb, t.args); } finally { t.calling = false; rt.fiberSwitchBlocked--; }
  }
}

const STMT = {
  Block(n) { return cStmts(n.body); },
  Echo(n) {
    const l = n.l;
    if (n.args.length === 1 && n.args[0].k === 'Lit') { const s = toStr(n.args[0].v); return () => { rt.echo(s); }; }
    const args = n.args.map(cExpr);
    if (args.length === 1) { const A = args[0]; return (f) => { rt.line = l; if (idq.n) idSafePoint(); const v = A(f); rt.echo(typeof v === 'string' ? v : toStr(v)); }; }
    return (f) => { rt.line = l; if (idq.n) idSafePoint(); for (let i = 0; i < args.length; i++) { const v = args[i](f); rt.echo(typeof v === 'string' ? v : toStr(v)); } };
  },
  ExprStmt(n) {
    if (n.e.k === 'Var' && n.e.name !== 'this') return () => undefined; // `$x;` compiles to nothing in PHP (no warning)
    const E = cExpr(n.e); const l = n.l;
    // statement starts are where freed object handles get reclaimed (see runtime/gc.js)
    if (n.e.k === 'Assign' || n.e.k === 'AssignOp' || n.e.k === 'PreInc' || n.e.k === 'PostInc' || n.e.k === 'AssignRef') return (f) => { rt.line = l; if (idq.n) idSafePoint(); E(f); };
    return (f) => {
      rt.line = l;
      if (idq.n) idSafePoint();
      const v = E(f);
      if (v instanceof PHPObject) { dropRef(v); if (v.cls.hasDestructor && !v.destructed) gcCheck(v); }
    };
  },
  If(n) {
    const conds = [cExpr(n.c), ...n.elifs.map((e) => cExpr(e.c))];
    const bodies = [cBody(n.then), ...n.elifs.map((e) => cBody(e.body))];
    const els = n.els ? cBody(n.els) : null;
    const l = n.l;
    const parts = [...bodies, els];
    const enter = (f, label) => parts.find((p) => p && p.labels && p.labels.has(label)).enter(f, label);
    if (conds.length === 1) {
      const C = conds[0], T = bodies[0];
      if (els) return exposeLabels((f) => { rt.line = l; return toBool(C(f)) ? T(f) : els(f); }, parts, enter);
      return exposeLabels((f) => { rt.line = l; if (toBool(C(f))) return T(f); }, parts, enter);
    }
    return exposeLabels((f) => {
      rt.line = l;
      for (let i = 0; i < conds.length; i++) if (toBool(conds[i](f))) return bodies[i](f);
      if (els) return els(f);
    }, parts, enter);
  },
  While(n) {
    const C = cExpr(n.c), B = cBody(n.body), l = n.l;
    return (f) => {
      rt.line = l;
      while (toBool(C(f))) {
        if (rt.deadline !== 0) checkTimeLimit();
        const r = B(f);
        if (r !== undefined) {
          if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
          if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
          return r;
        }
      }
    };
  },
  DoWhile(n) {
    const C = cExpr(n.c), B = cBody(n.body);
    return (f) => {
      do {
        if (rt.deadline !== 0) checkTimeLimit();
        const r = B(f);
        if (r !== undefined) {
          if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
          if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
          return r;
        }
      } while (toBool(C(f)));
    };
  },
  For(n) {
    const init = n.init.map(cExpr), cond = n.cond.map(cExpr), step = n.step.map(cExpr), B = cBody(n.body), l = n.l;
    return (f) => {
      rt.line = l;
      for (const e of init) e(f);
      for (;;) {
        let ok = true;
        for (let i = 0; i < cond.length; i++) { const v = cond[i](f); if (i === cond.length - 1) ok = toBool(v); }
        if (!ok) break;
        if (rt.deadline !== 0) checkTimeLimit();
        const r = B(f);
        if (r !== undefined) {
          if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
          if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); }
          else return r;
        }
        for (let i = 0; i < step.length; i++) step[i](f);
      }
    };
  },
  Foreach(n) {
    const E = cExpr(n.e);
    const LE = n.byRef ? cLval(n.e) : null;
    const subjIsVar = ['Var', 'Index', 'Prop', 'SProp', 'VarVar'].includes(n.e.k);
    const K = n.kv ? cLval(n.kv) : null;
    const V = cLval(n.v);
    const isList = n.v.k === 'List';
    const B = cBody(n.body), l = n.l;
    const simpleVar = n.v.k === 'Var' && typeof n.v.name === 'string' && n.v.name !== 'this' && !SUPERGLOBALS.has(n.v.name) ? n.v.name : null;
    const handle = (r) => r; // eslint helper
    void handle;
    return (f) => {
      rt.line = l;
      if (n.byRef) {
        const subj0 = LE.getq(f);
        if (subj0 instanceof PHPObject) {
          if (subj0.cls.ancestors.has('iterator') && subj0.cls.lname !== 'generator') throwError('Error', 'An iterator cannot be used with foreach by reference');
          if (subj0.gen && !subj0.gen.fn.byRef) throwError('Exception', 'You can only iterate a generator by-reference if it declared that it yields by-reference');
          return foreachObject(f, subj0, K, V, B, true, isList);
        }
        if (subj0 !== undefined && subj0 !== null && !(subj0 instanceof PHPArray)) { warn(`foreach() argument must be of type array|object, ${valueName(subj0)} given`); return; }
        let arr = LE.arr(f);
        if (!(arr instanceof PHPArray)) return foreachObject(f, arr, K, V, B, true, isList);
        // like PHP's hash iterators: the position is the next index to look at, and it follows
        // the entries when functions like array_shift() renumber the array
        const it = { pos: 0 };
        const attach = (a) => { a.iters++; (a.itList || (a.itList = [])).push(it); };
        const detach = (a) => { a.iters--; const l = a.itList; l.splice(l.indexOf(it), 1); };
        attach(arr);
        try {
          for (;;) {
            // the variable may have been given another array
            const cur = subjIsVar ? LE.getq(f) : arr;
            if (cur !== arr) {
              if (!(cur instanceof PHPArray)) break;
              detach(arr);
              arr = LE.arr(f); // the position carries over
              attach(arr);
            }
            let i = it.pos;
            while (i < arr.k.length && arr.k[i] === undefined) i++;
            if (i >= arr.k.length) break;
            it.pos = i + 1;
            const key = arr.k[i];
            let slot = arr.v[i];
            if (!(slot instanceof Ref)) { slot = new Ref(slot); arr.v[i] = slot; }
            V.bind(f, slot);
            if (K) K.set(f, key);
            const r = B(f);
            if (r !== undefined) {
              if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
              if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
              return r;
            }
          }
        } finally { detach(arr); }
        return;
      }
      const subj = E(f);
      if (subj instanceof PHPArray) {
        if (subj.size === 0) return;
        subj.fe = (subj.fe || 0) + 1;
        feSubjects.push(subj);
        try {
          const ks = subj.k, vs = subj.v;
          for (let i = 0; i < ks.length; i++) {
            const key = ks[i];
            if (key === undefined) continue;
            let v = vs[i];
            if (v instanceof Ref) v = v.v;
            if (v instanceof PHPArray) v.cow = true;
            if (simpleVar !== null) { const r = f.vars[simpleVar]; if (r !== undefined) r.v = v; else f.vars[simpleVar] = new Ref(v); }
            else if (isList) V.listAssign(f, v, null);
            else V.set(f, v);
            if (K) K.set(f, key);
            const r = B(f);
            if (r !== undefined) {
              if (r.t === 1) { if (r.n > 1) return mkBreak(r.n - 1); break; }
              if (r.t === 2) { if (r.n > 1) return mkCont(r.n - 1); continue; }
              return r;
            }
          }
        } finally { subj.fe--; feSubjects.pop(); dropRef(subj); }
        return;
      }
      if (subj instanceof PHPObject) {
        feSubjects.push(subj);
        try { return foreachObject(f, subj, K, V, B, false, isList); } finally { feSubjects.pop(); dropRef(subj); }
      }
      warn(`foreach() argument must be of type array|object, ${valueName(subj)} given`);
    };
  },
  Switch(n) {
    const E = cExpr(n.e);
    const flat = [], flatNodes = [];
    const starts = [];
    let defIdx = -1;
    for (const c of n.cases) {
      starts.push({ T: c.test ? cExpr(c.test) : null, at: flat.length });
      if (!c.test) defIdx = starts.length - 1;
      for (const s of c.body) { const cs = cStmt(s); if (cs) { flat.push(cs); flatNodes.push(s); } }
    }
    const targets = gotoTargets(flat, flatNodes); // gotos between labels inside the switch
    const l = n.l;
    return (f) => {
      rt.line = l;
      const v = E(f);
      let start = -1;
      for (let i = 0; i < starts.length; i++) { const s = starts[i]; if (s.T && looseEq(v, s.T(f))) { start = s.at; break; } }
      if (start < 0) { if (defIdx < 0) return; start = starts[defIdx].at; }
      for (let i = start; i < flat.length; i++) {
        let r = flat[i](f);
        while (r !== undefined && r.t === GOTO && targets && targets.has(r.label)) {
          i = targets.get(r.label);
          r = flatNodes[i].k === 'Label' ? undefined : flat[i].enter(f, r.label);
        }
        if (r !== undefined) {
          if (r.t === 1 || r.t === 2) { if (r.n > 1) return r.t === 1 ? mkBreak(r.n - 1) : mkCont(r.n - 1); return; }
          return r;
        }
      }
    };
  },
  Break(n) { const r = mkBreak(n.n); return () => r; },
  Continue(n) { const r = mkCont(n.n); return () => r; },
  Return(n) {
    if (!n.e) return (f) => { f.ret = null; return RETURN; };
    if (compilingByRef && isLvalNode(n.e)) {
      const L = cLval(n.e); const l = n.l;
      return (f) => { rt.line = l; const r = L.ref(f); f.ret = r.v; f.retRef = r; return RETURN; };
    }
    if (compilingByRef && n.e.k !== 'Call' && n.e.k !== 'MCall' && n.e.k !== 'SCall' && n.e.k !== 'New') {
      const E0 = cValue(n.e); const l = n.l;
      return (f) => { rt.line = l; f.ret = E0(f); notice('Only variable references should be returned by reference'); return RETURN; };
    }
    if (compilingByRef) {
      const E0 = cValue(n.e); const l = n.l;
      return (f) => { rt.line = l; rt.lastRetRef = null; const v = E0(f); const r = rt.lastRetRef; rt.lastRetRef = null; f.ret = v; if (r !== null && r !== NOREF && r.v === v) f.retRef = r; else if (r !== NOREF) notice('Only variable references should be returned by reference'); return RETURN; };
    }
    const E = cValue(n.e); const l = n.l;
    return (f) => { rt.line = l; if (idq.n) idSafePoint(); f.ret = E(f); return RETURN; };
  },
  Try(n) {
    const B = cBody(n.body);
    const catches = n.catches.map((c) => ({ types: c.types.map((t) => t.toLowerCase()), v: c.v, B: cBody(c.body) }));
    const F = n.fin ? cBody(n.fin) : null;
    // label: entering the try body (or a catch body, see below) at a goto label
    const run0 = (f, label, mark) => {
      let res;
      try {
        if (label !== undefined && catches.some((c) => c.B.labels && c.B.labels.has(label))) {
          const c = catches.find((x) => x.B.labels && x.B.labels.has(label));
          if (!F) return c.B.enter(f, label);
          try { res = c.B.enter(f, label); }
          finally { const fr = F(f); if (fr !== undefined) return fr; } // eslint-disable-line no-unsafe-finally
          return res;
        }
        res = label === undefined ? B(f) : B.enter(f, label);
      } catch (e) {
        const sig = toThrowSig(e);
        if (!sig) throw e;
        const obj = sig.obj;
        // objects the try block created that only the unwound expressions held are gone
        const created = objHandles.recent.slice(mark);
        objHandles.recent.length = mark;
        if (created.length) caughtTemps(created);
        let handled = false;
        for (const c of catches) {
          if (c.types.some((t) => obj.cls.ancestors.has(t))) {
            if (c.v) { const r = f.vars[c.v]; if (r) { const old = r.v; r.v = obj; if (old !== obj && old !== null && typeof old === 'object') dropRef(old); } else f.vars[c.v] = new Ref(obj); }
            handled = true;
            if (F) {
              try { res = c.B(f); }
              finally { const fr = F(f); if (fr !== undefined) return fr; } // eslint-disable-line no-unsafe-finally
              return res;
            }
            return c.B(f);
          }
        }
        if (!handled) {
          if (F) { const fr = F(f); if (fr !== undefined) return fr; }
          throw sig;
        }
      }
      if (F) { const fr = F(f); if (fr !== undefined) return fr; }
      return res;
    };
    const run = (f, label) => {
      const outer = objHandles.recent, mark = outer === null ? 0 : outer.length;
      if (outer === null) objHandles.recent = [];
      try { return run0(f, label, mark); }
      finally { if (outer === null) objHandles.recent = null; else if (outer.length > mark) outer.length = mark; }
    };
    return exposeLabels((f) => run(f, undefined), [B, ...catches.map((c) => c.B)], run);
  },
  Label() { return () => undefined; },
  Nop() { return () => undefined; },
  Goto(n) { const sig = { t: GOTO, label: n.label }; return () => sig; },
  Global(n) {
    const names = n.names.map((x) => (typeof x === 'string' ? x : cExpr(x.e)));
    return (f) => {
      for (const x of names) {
        const name = typeof x === 'string' ? x : toStr(x(f));
        f.vars[name] = rt.globals[name] || (rt.globals[name] = new Ref(null));
      }
    };
  },
  StaticVar(n) {
    const vars = n.vars.map((v) => ({ name: v.name, init: v.init ? cExpr(v.init) : null }));
    return (f) => {
      let st = f.statics;
      if (!st) {
        const owner = f.closure || f.fn;
        if (!owner) { st = rt.mainStatics || (rt.mainStatics = new Map()); }
        else {
          if (!owner.statics) { owner.statics = new Map(); rt.staticOwners.add(owner); }
          st = owner.statics;
          // methods: statics are per-class (late static binding scope)
          if (f.fn && f.fn.isMethod && f.sc && !f.closure) {
            let m = owner.staticsByClass; if (!m) m = owner.staticsByClass = new Map();
            st = m.get(f.sc); if (!st) { st = new Map(); m.set(f.sc, st); }
          }
        }
        f.statics = st;
      }
      for (const v of vars) {
        let r = st.get(v.name);
        if (!r) { r = new Ref(v.init ? cp(v.init(f)) : null); st.set(v.name, r); }
        f.vars[v.name] = r;
      }
    };
  },
  Unset(n) {
    const ls = n.list.map(cLval);
    const l = n.l;
    return (f) => { rt.line = l; for (const lv of ls) lv.unset(f); };
  },
  ConstDecl(n) {
    const items = n.items.map((i) => ({ name: i.name, E: cExpr(i.e) }));
    return (f) => {
      for (const it of items) {
        if (rt.consts.has(it.name)) { warn(`Constant ${it.name} already defined`); continue; }
        const v = it.E(f);
        rt.consts.set(it.name, v);
        if (v !== null && typeof v === 'object') rt.constRoots.push(v);
      }
    };
  },
  FuncDecl(n) {
    if (n.hoisted) return null;
    const decl = n.fn;
    return () => { declareFunction(decl); };
  },
  ClassDecl(n) {
    return (f) => { if (!n.declared) declareClass(n, f); };
  },
};

// ---------------------------------------------------------------- foreach over objects
function foreachObject(f, obj, K, V, B, byRef, isList) {
  const assignV = (v) => { if (isList) V.listAssign(f, v, null); else V.set(f, cp(v)); };
  const run = () => { const r = B(f); return r; };
  const handle = (r) => {
    if (r === undefined) return 0;
    if (r.t === 1) return r.n > 1 ? mkBreak(r.n - 1) : 1;
    if (r.t === 2) return r.n > 1 ? mkCont(r.n - 1) : 0;
    return r;
  };
  if (obj.cls === generatorClass) {
    const g = obj.gen;
    g.ensure(true);
    while (!g.done) {
      if (byRef) { const rr = g.curRef || new Ref(g.cur); V.bind(f, rr); } else assignV(g.cur);
      if (K) K.set(f, g.key);
      const h = handle(run());
      if (h === 1) return; if (h !== 0) return h;
      g.next();
    }
    return;
  }
  if (obj.cls.ancestors.has('iterator')) {
    callMethodName(obj, 'rewind', []);
    while (toBool(callMethodName(obj, 'valid', []))) {
      const v = callMethodName(obj, 'current', []);
      if (byRef) V.bind(f, new Ref(v)); else assignV(v);
      if (K) K.set(f, callMethodName(obj, 'key', []));
      const h = handle(run());
      if (h === 1) return; if (h !== 0) return h;
      callMethodName(obj, 'next', []);
    }
    return;
  }
  if (obj.cls.ancestors.has('iteratoraggregate')) {
    const it = callMethodName(obj, 'getIterator', []);
    if (!(it instanceof PHPObject) || !it.cls.ancestors.has('traversable')) throwError('Exception', `Objects returned by ${obj.cls.name}::getIterator() must be traversable or implement interface Iterator`);
    return foreachObject(f, it, K, V, B, byRef, isList);
  }
  if (obj.cls.nativeIter) {
    const entries = obj.cls.nativeIter(obj);
    for (const [k, v] of entries) {
      assignV(v); if (K) K.set(f, k);
      const h = handle(run());
      if (h === 1) return; if (h !== 0) return h;
    }
    return;
  }
  // plain object: visible properties, from the live property table (properties added meanwhile
  // are visited too, as in PHP)
  const keys = obj.props.keys();
  for (const k of keys) {
    if (!obj.props.has(k)) continue;
    let name = k;
    if (k.charCodeAt(0) === 0) {
      const p = k.indexOf('\0', 1);
      if (!f.cls || f.cls.name !== k.slice(1, p)) continue;
      name = k.slice(p + 1);
    } else {
      const info = obj.cls.props.get(k);
      if (info && info.vis !== 'public' && !propAccessible(info, f.cls)) continue;
    }
    if (byRef) {
      let slot = obj.props.get(k);
      if (!(slot instanceof Ref)) { slot = new Ref(slot); obj.props.set(k, slot); }
      V.bind(f, slot);
    } else { const s = obj.props.get(k); assignV(s instanceof Ref ? s.v : s); }
    if (K) K.set(f, normKey(name));
    const h = handle(run());
    if (h === 1) return; if (h !== 0) return h;
  }
}

// iterate any Traversable with a JS callback (used by builtins)
export function iterateObject(obj, cb) {
  if (obj.cls === generatorClass) {
    const g = obj.gen; g.ensure(true);
    while (!g.done) { if (cb(g.key, g.cur) === false) return; g.next(); }
    return;
  }
  if (obj.cls.ancestors.has('iterator')) {
    callMethodName(obj, 'rewind', []);
    while (toBool(callMethodName(obj, 'valid', []))) {
      const v = callMethodName(obj, 'current', []);
      const k = callMethodName(obj, 'key', []);
      if (cb(k, v) === false) return;
      callMethodName(obj, 'next', []);
    }
    return;
  }
  if (obj.cls.ancestors.has('iteratoraggregate')) return iterateObject(callMethodName(obj, 'getIterator', []), cb);
  if (obj.cls.nativeIter) { for (const [k, v] of obj.cls.nativeIter(obj)) if (cb(k, v) === false) return; return; }
  for (const [k, s] of objectProps(obj)) {
    const info = obj.cls.props.get(k);
    if (info && info.vis !== 'public' && !canAccessMember(info, rt.frame ? rt.frame.cls : null)) continue;
    if (cb(normKey(k), s instanceof Ref ? s.v : s) === false) return;
  }
}
