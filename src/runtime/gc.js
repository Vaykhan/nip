// Destructor support: targeted reachability checks emulate PHP's refcount-based
// destruction timing for objects that define __destruct().

import { Flt, objHandles, PHPArray, PHPObject, Ref } from '../values.js';
import { Frame } from '../compiler/common.js';
import { rt } from './state.js';
import { callFunction, NativeFrame } from './functions.js';

function gcVisitRoots(push, extra) {
  const g = rt.globals;
  for (const k in g) push(g[k]);
  for (const e of rt.stack) push(e);
  for (const st of rt.suspendedFibers) for (const e of st.stack) push(e);
  if (rt.frame) push(rt.frame);
  if (rt.mainStatics) push(rt.mainStatics);
  const seenFn = new Set();
  const fnRoots = (fn) => { if (!fn || seenFn.has(fn)) return; seenFn.add(fn); if (fn.statics) push(fn.statics); if (fn.staticsByClass) for (const m of fn.staticsByClass.values()) push(m); };
  for (const fn of rt.fns.values()) if (!fn.native) fnRoots(fn);
  for (const cls of new Set(rt.classes.values())) {
    for (const si of cls.sprops.values()) push(si.ref);
    for (const m of cls.methods.values()) fnRoots(m.fn);
    for (const c of cls.consts.values()) if (c.done) push(c.val);
  }
  for (const h of rt.errorHandlers) push(h.handler);
  for (const h of rt.exceptionHandlers) push(h);
  for (const [cb, a] of rt.shutdownFns) { push(cb); push(a); }
  for (const a of rt.autoloaders) push(a);
  for (const ob of rt.obStack) if (ob.cb) push(ob.cb);
  if (extra) for (const x of extra) push(x);
}
function gcTraverse(cands, extra, countMode) {
  const seen = new Set();
  const stack = [];
  const push = (v) => { if (v !== null && typeof v === 'object' && !(v instanceof Flt)) stack.push(v); };
  gcVisitRoots(push, extra);
  let remaining = cands ? cands.size : 0;
  const counts = countMode ? new Map() : null;
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PHPObject && countMode && v.cls.hasDestructor) counts.set(v, (counts.get(v) || 0) + 1);
    if (seen.has(v)) continue;
    seen.add(v);
    if (cands && v instanceof PHPObject && cands.has(v)) { if (--remaining === 0 && !countMode) return seen; }
    if (v instanceof Ref) push(v.v);
    else if (v instanceof PHPArray) { const vs = v.v, ks = v.k; for (let i = 0; i < vs.length; i++) if (ks[i] !== undefined) push(vs[i]); }
    else if (v instanceof PHPObject) {
      for (const x of v.props.values()) push(x);
      if (v.bound) for (const x of v.bound.values()) push(x);
      if (v.thisObj) push(v.thisObj);
      if (v.statics) push(v.statics);
      if (v.gen) push(v.gen.f);
    } else if (v instanceof Frame) {
      for (const k in v.vars) push(v.vars[k]);
      if (v.this) push(v.this);
      if (v.args) push(v.args);
      if (v.temps) for (const k in v.temps) push(v.temps[k]);
      if (v.closure) push(v.closure);
      if (v.ret) push(v.ret);
    } else if (v instanceof Map) { for (const x of v.values()) push(x); }
    else if (Array.isArray(v)) { for (const x of v) push(x); }
  }
  return countMode ? counts : seen;
}
// count how many holders (variables, array slots, properties, ...) share each reference
export function refHolderCounts(extra) {
  const counts = new Map();
  const seen = new Set();
  const stack = [];
  const holder = (v) => { if (v instanceof Ref) counts.set(v, (counts.get(v) || 0) + 1); if (v !== null && typeof v === 'object' && !(v instanceof Flt)) stack.push(v); };
  const g = rt.globals;
  for (const k in g) holder(g[k]);
  seen.add(rt.globalFrame);
  if (rt.globalFrame) seen.add(rt.globalFrame.vars);
  for (const e of rt.stack) if (e instanceof Frame && e !== rt.globalFrame) stack.push(e);
  if (rt.frame && rt.frame !== rt.globalFrame) stack.push(rt.frame);
  for (const fn of rt.fns.values()) if (!fn.native && fn.statics) stack.push(fn.statics);
  for (const cls of new Set(rt.classes.values())) for (const si of cls.sprops.values()) holder(si.ref);
  if (extra) for (const x of extra) stack.push(x);
  while (stack.length) {
    const v = stack.pop();
    if (seen.has(v)) continue;
    seen.add(v);
    if (v instanceof Ref) { const x = v.v; if (x !== null && typeof x === 'object' && !(x instanceof Flt)) stack.push(x); }
    else if (v instanceof PHPArray) { const vs = v.v, ks = v.k; for (let i = 0; i < vs.length; i++) if (ks[i] !== undefined) holder(vs[i]); }
    else if (v instanceof PHPObject) {
      for (const x of v.props.values()) holder(x);
      if (v.bound) for (const x of v.bound.values()) holder(x);
      if (v.statics) stack.push(v.statics);
      if (v.gen) stack.push(v.gen.f);
    } else if (v instanceof Frame) { for (const k in v.vars) holder(v.vars[k]); if (v.this) stack.push(v.this); }
    else if (v instanceof Map) { for (const x of v.values()) holder(x); }
  }
  return counts;
}
export function containsRefSlot(v, seen) {
  if (v instanceof PHPArray) {
    if (seen.has(v)) return false; seen.add(v);
    for (let i = 0; i < v.v.length; i++) { const x = v.v[i]; if (x instanceof Ref) return true; if (x instanceof PHPArray && containsRefSlot(x, seen)) return true; if (x instanceof PHPObject && containsRefSlot(x, seen)) return true; }
    return false;
  }
  if (v instanceof PHPObject) {
    if (seen.has(v)) return false; seen.add(v);
    for (const x of v.props.values()) { if (x instanceof Ref) return true; if ((x instanceof PHPArray || x instanceof PHPObject) && containsRefSlot(x, seen)) return true; }
  }
  return false;
}
function runDestructor(o) {
  if (o.destructed) return;
  o.destructed = true;
  const i = rt.destructibles.indexOf(o);
  if (i >= 0) rt.destructibles.splice(i, 1);
  if (o.cls.nativeDestruct) { o.cls.nativeDestruct(o); return; } // internal classes (Fiber)
  const m = o.cls.methods.get('__destruct');
  if (m) callFunction(m.fn, [], o, m.cls, o.cls, null);
  if (!rt.inShutdown) idCands.add(o);
}
export function gcCollect(list, extra) {
  const cands = new Set(list.filter((o) => !o.destructed));
  if (!cands.size) return [];
  const seen = gcTraverse(cands, extra, false);
  const survivors = [];
  for (const o of cands) { if (seen.has(o)) survivors.push(o); else runDestructor(o); }
  return survivors;
}
export function gcCheck(old) { // called when a reference to `old` is dropped
  if (old instanceof PHPObject && old.cls.hasDestructor && !old.destructed && !rt.inShutdown) gcCollect([old], null);
}
export function gcAfterCall(f, ret) {
  const list = f.destr; f.destr = null;
  const survivors = gcCollect(list, [ret]);
  if (survivors.length) {
    const caller = rt.frame;
    if (caller && caller !== rt.globalFrame) { if (!caller.destr) caller.destr = []; for (const o of survivors) caller.destr.push(o); }
  }
}
export function gcShutdown() {
  rt.inShutdown = true;
  // pass 1: globals in reverse order holding the only reference to an object
  for (let guard = 0; guard < 100; guard++) {
    if (!rt.destructibles.length) return;
    const counts = gcTraverse(null, null, true);
    let changed = false;
    const names = Object.keys(rt.globals).reverse();
    for (const k of names) {
      const r = rt.globals[k];
      if (!r) continue;
      const v = r.v;
      if (v instanceof PHPObject && v.cls.hasDestructor && !v.destructed && counts.get(v) === 1) { delete rt.globals[k]; runDestructor(v); changed = true; }
    }
    if (!changed) break;
  }
  // pass 2: remaining objects in creation order
  while (rt.destructibles.length) runDestructor(rt.destructibles[0]);
}

// ---------------------------------------------------------------- object handle reuse
// PHP frees an object when its last reference goes, and the next new object gets its handle
// (#N in var_dump, spl_object_id()). NIP has no reference counts. Instead, objects whose
// reference was dropped become candidates, and a reachability scan from the roots decides
// which of them are gone; their handles are freed, most recently freed first.
//  - When a function or builtin returns, its locals and arguments are dropped at once (minus
//    whatever its return value reaches): the caller's half-evaluated expression can't hold them.
//  - Overwritten and unset values are checked at the start of the next statement, when no
//    half-built argument list or array literal can hold them.
// Only objects that were stored somewhere PHP code can see become candidates, so temporaries
// held by the interpreter are never freed. A scan that gets expensive (large heaps) gives up
// without freeing anything.
const idCands = new Set();
export const idq = { n: 0 }; // > 0 when a statement start has candidates to check
export const feSubjects = []; // subjects of running foreach loops (held by the loop, not a variable)
// Scans cost work (values and slots visited); scanning is paid from a budget that starts large
// (short scripts get PHP's exact handle numbers) and refills a little at every statement, so
// long-running code with big heaps spends a bounded share of its time on it.
const BUDGET_MAX = 1000000, BUDGET_REFILL = 0.25;
let budget = BUDGET_MAX;

function addCands(v, excl, out, depth) {
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPObject) {
    if (v.idFreed || (excl && excl.has(v))) return;
    out.add(v);
    if (depth < 3) for (const x of v.props.values()) addCands(x, excl, out, depth + 1);
  } else if (v instanceof PHPArray && depth < 3 && v.size && v.size <= 64 && !(excl && excl.has(v))) {
    const vs = v.v, ks = v.k;
    for (let i = 0; i < vs.length; i++) if (ks[i] !== undefined) addCands(vs[i], excl, out, depth + 1);
  }
}
// a reference to v (an object or an array that may contain objects) was dropped
export function dropRef(v) {
  if (budget <= 0) return;
  if (v instanceof PHPObject) { if (!v.idFreed) { idCands.add(v); idq.n = 1; } }
  else if (v instanceof PHPArray && v.size && v.size <= 64) { addCands(v, null, idCands, 0); idq.n = 1; }
}
function reach(v) {
  const seen = new Set(), stack = [v];
  while (stack.length) {
    let x = stack.pop();
    if (x instanceof Ref) x = x.v;
    if (x === null || typeof x !== 'object' || seen.has(x)) continue;
    if (x instanceof PHPObject) { seen.add(x); for (const y of x.props.values()) stack.push(y); if (x.bound) for (const y of x.bound.values()) stack.push(y); if (x.thisObj) stack.push(x.thisObj); if (x.refl) stack.push(x.refl.obj); }
    else if (x instanceof PHPArray) { if (x.size > 64) continue; seen.add(x); for (let i = 0; i < x.v.length; i++) if (x.k[i] !== undefined) stack.push(x.v[i]); }
  }
  return seen;
}
// a user function returned (vars: its local variables) or a builtin did (vars: its arguments).
// ret (the return value or the thrown exception) and self (the object a constructor built) are in
// flight, held by no variable yet: what they refer to stays.
export function frameExit(vars, ret, self) {
  if (budget < BUDGET_MAX) budget += BUDGET_REFILL;
  if (budget <= 0) return; // spent: handles aren't reused for a while
  const excl = ret !== null && typeof ret === 'object' ? reach(ret) : null;
  if (self) { if (excl) { for (const x of reach(self)) excl.add(x); } else return frameExit(vars, self); }
  const cands = new Set();
  for (const k in vars) addCands(vars[k], excl, cands, 0);
  if (!cands.size) return;
  // without budget, check them at a later statement start instead
  if (!sweep(cands, ret, self)) { for (const o of cands) idCands.add(o); idq.n = 1; }
}
// an exception was caught: objects created in the try block that only the unwound expressions
// held are gone (checked at the next statement)
export function caughtTemps(objs) {
  if (budget <= 0) return;
  for (const o of objs) if (!o.idFreed) idCands.add(o);
  if (idCands.size) idq.n = 1;
}
// at the start of a statement
export function idSafePoint() {
  idq.n = 0;
  if (budget < BUDGET_MAX) budget += BUDGET_REFILL;
  if (budget <= 0) { idCands.clear(); return; }
  if (sweep(idCands)) idCands.clear();
  else idq.n = 1;
}
// the places holding values when no expression is half-evaluated
function visitIdRoots(push) {
  push(feSubjects);
  push(rt.constRoots);
  for (const t of rt.tickFns) push(t.cb);
  for (const h of rt.errorHandlers) push(h.handler);
  for (const h of rt.exceptionHandlers) push(h);
  for (const [cb, a] of rt.shutdownFns) { push(cb); push(a); }
  for (const a of rt.autoloaders) push(a);
  for (const ob of rt.obStack) if (ob.cb) push(ob.cb);
  for (const cls of rt.classes.values()) {
    if (cls.sprops.size) for (const si of cls.sprops.values()) push(si.ref);
  }
  for (const fn of rt.staticOwners) { if (fn.statics) push(fn.statics); if (fn.staticsByClass) for (const m of fn.staticsByClass.values()) push(m); }
  if (rt.mainStatics) push(rt.mainStatics);
  for (const st of rt.suspendedFibers) for (const e of st.stack) push(e);
  const g = rt.globals;
  for (const k in g) push(g[k]);
  for (const e of rt.stack) push(e);
  if (rt.frame) push(rt.frame);
}
// free the handles of the candidates nothing reachable from the roots refers to; false when
// the budget ran out first
function sweep(cands, ret, self) {
  let pending = 0;
  for (const o of cands) if (!o.idFreed && (!o.cls.hasDestructor || o.destructed)) pending++;
  if (pending === 0) return true;
  const seen = new Set(), stack = [];
  const push = (v) => { if (v !== null && typeof v === 'object' && !(v instanceof Flt)) stack.push(v); };
  visitIdRoots(push);
  push(ret); push(self);
  let work = stack.length;
  while (stack.length && pending > 0) {
    const v = stack.pop();
    if (seen.has(v)) continue;
    seen.add(v);
    if (++work > budget) { budget -= work; return false; }
    if (v instanceof PHPObject) {
      if (cands.has(v)) pending--;
      work += v.props.size;
      for (const x of v.props.values()) push(x);
      if (v.bound) for (const x of v.bound.values()) push(x);
      if (v.thisObj) push(v.thisObj);
      if (v.statics) push(v.statics);
      if (v.gen) { push(v.gen.f); push(v.gen.cur); push(v.gen.key); push(v.gen.ret); push(v.gen.sent); }
      if (v.refl) push(v.refl.obj);
      if (v.fiber) push(v.fiber);
      if (v.trace) push(v.trace);
    } else if (v instanceof Ref) push(v.v);
    else if (v instanceof PHPArray) { const vs = v.v, ks = v.k; work += vs.length; for (let i = 0; i < vs.length; i++) { const x = vs[i]; if (x !== null && typeof x === 'object' && ks[i] !== undefined) stack.push(x); } }
    else if (v instanceof Frame) {
      for (const k in v.vars) push(v.vars[k]);
      if (v.this) push(v.this);
      if (v.args) push(v.args);
      if (v.temps) for (const k in v.temps) push(v.temps[k]);
      if (v.closure) push(v.closure);
      if (v.ret) push(v.ret);
    } else if (v instanceof NativeFrame) { push(v.args); push(v.this); }
    else if (v instanceof Map) { work += v.size; for (const x of v.values()) push(x); }
    else if (Array.isArray(v)) { work += v.length; for (const x of v) push(x); }
    else if (v.f instanceof Frame) push(v.f); // fiber/generator states
  }
  budget -= work;
  if (pending === 0) return true;
  // PHP's reference counting doesn't free garbage cycles (until cycle collection runs), nor what
  // they refer to
  const dead = [];
  for (const o of cands) if (!seen.has(o) && !o.idFreed && (!o.cls.hasDestructor || o.destructed)) dead.push(o);
  const kept = new Set();
  for (const o of dead) {
    if (kept.has(o)) continue;
    const r = reachFrom(o);
    if (r.has(o)) for (const x of r) kept.add(x);
  }
  for (const o of dead) {
    if (kept.has(o)) continue;
    o.idFreed = true;
    objHandles.free.push(o.id);
  }
  return true;
}
// objects reachable from o's properties (o itself only through a cycle)
function reachFrom(o) {
  const seen = new Set(), stack = [];
  for (const x of o.props.values()) stack.push(x);
  let n = 0;
  while (stack.length && n++ < 10000) {
    let x = stack.pop();
    if (x instanceof Ref) x = x.v;
    if (x === null || typeof x !== 'object' || seen.has(x)) continue;
    seen.add(x);
    if (x instanceof PHPObject) { for (const y of x.props.values()) stack.push(y); if (x.bound) for (const y of x.bound.values()) stack.push(y); if (x.thisObj) stack.push(x.thisObj); }
    else if (x instanceof PHPArray) { for (let i = 0; i < x.v.length; i++) if (x.k[i] !== undefined) stack.push(x.v[i]); }
  }
  return seen;
}
export function resetObjHandles() {
  objHandles.next = 0; objHandles.free.length = 0; idCands.clear(); feSubjects.length = 0; budget = BUDGET_MAX; idq.n = 0;
}
