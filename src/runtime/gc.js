// Destructor support: targeted reachability checks emulate PHP's refcount-based
// destruction timing for objects that define __destruct().

import { Flt, PHPArray, PHPObject, Ref } from '../values.js';
import { Frame } from '../compiler/common.js';
import { rt } from './state.js';
import { callFunction } from './functions.js';

function gcVisitRoots(push, extra) {
  const g = rt.globals;
  for (const k in g) push(g[k]);
  for (const e of rt.stack) push(e);
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
  const m = o.cls.methods.get('__destruct');
  if (m) callFunction(m.fn, [], o, m.cls, o.cls, null);
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
