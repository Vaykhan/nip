// Generator objects (current/next/send/throw, yield from).

import { PHPObject, ThrowSig } from '../values.js';
import { RETURN } from '../compiler/common.js';
import { rt } from './state.js';
import { throwError } from './errors.js';
import { compileBody } from './functions.js';
import { generatorClass } from './native-classes.js';
import { FiberExit } from './fibers.js';

export class GenThrow { constructor(obj) { this.obj = obj; } }

function* genMain(fn, f) {
  if (!fn.genBody) compileBody(fn);
  const r = yield* fn.genBody(f);
  return r === RETURN ? f.ret : null;
}
// whether statements contain a finally block (not in nested functions)
function hasFinally(n) {
  if (!n || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some(hasFinally);
  if (n.k === 'Try' && n.fin) return true;
  if (n.k === 'Closure' || n.k === 'FuncDecl' || n.k === 'ClassDecl') return false;
  for (const key in n) if (key !== 'l' && n[key] && typeof n[key] === 'object' && hasFinally(n[key])) return true;
  return false;
}
class GenState {
  constructor(fn, f) {
    this.fn = fn; this.f = f; this.it = null; this.started = false; this.done = false; this.running = false;
    this.key = null; this.cur = null; this.curRef = null; this.ret = null; this.autoKey = -1; this.advanced = false;
  }
  ensure() {
    if (this.started) return;
    this.started = true; this.it = genMain(this.fn, this.f);
    // a generator with finally blocks runs them when destroyed unfinished (see destroy())
    if (this.fn.genFinally === undefined) this.fn.genFinally = hasFinally(this.fn.decl && this.fn.decl.body);
    if (this.fn.genFinally && this.obj) rt.destructibles.push(this.obj);
    this.step(undefined);
  }
  needsDestroy() { return this.started && !this.done && !this.running && !!this.fn.genFinally; }
  step(val) {
    if (this.running) throwError('Error', 'Cannot resume an already running generator');
    this.running = true;
    const prevFrame = rt.frame, prevFile = rt.file, prevLine = rt.line;
    rt.frame = this.f; rt.file = this.fn.file;
    this.f.callLine = prevLine; this.f.callFile = prevFile;
    rt.stack.push(this.f);
    let r;
    try { r = this.it.next(val); }
    catch (e) { this.done = true; this.cur = null; this.key = null; this.untrack(); throw e; }
    finally { this.running = false; rt.stack.pop(); rt.frame = prevFrame; rt.file = prevFile; rt.line = prevLine; }
    if (r.done) { this.done = true; this.ret = r.value === undefined ? null : r.value; this.cur = null; this.key = null; this.curRef = null; this.untrack(); }
    else {
      const y = r.value;
      const k = y[0];
      if (k === undefined) this.key = ++this.autoKey;
      else { this.key = k; if (!y[2] && typeof k === 'number' && k > this.autoKey) this.autoKey = k; }
      this.cur = y[1]; this.curRef = y[3] || null;
    }
  }
  untrack() {
    if (!this.fn.genFinally || !this.obj) return;
    const i = rt.destructibles.indexOf(this.obj);
    if (i >= 0) rt.destructibles.splice(i, 1);
  }
  // destroying a suspended generator runs its pending finally blocks
  destroy() {
    if (!this.started || this.done || this.running) { this.done = true; return; }
    this.running = true;
    const prevFrame = rt.frame, prevFile = rt.file, prevLine = rt.line;
    rt.frame = this.f; rt.file = this.fn.file;
    rt.stack.push(this.f);
    // (FiberExit unwinds the body running finally blocks, as when a fiber is closed)
    try {
      const r = this.it.throw(new FiberExit());
      if (!r.done) this.it.return(undefined);
    } catch (e) { if (!(e instanceof FiberExit)) throw e; }
    finally { this.running = false; this.done = true; this.cur = null; this.key = null; rt.stack.pop(); rt.frame = prevFrame; rt.file = prevFile; rt.line = prevLine; }
  }
  next() { if (!this.started) { this.ensure(); } if (!this.done) { this.advanced = true; this.step(null); } }
  send(v) {
    if (!this.started) this.ensure();
    if (!this.done) { this.advanced = true; this.step(v); }
    return this.done ? null : this.cur;
  }
  throwIn(obj) {
    if (!this.started) this.ensure();
    if (this.done) throw new ThrowSig(obj);
    this.advanced = true;
    this.step(new GenThrow(obj));
    return this.done ? null : this.cur;
  }
}
export function makeGenerator(fn, f) {
  const o = new PHPObject(generatorClass);
  o.gen = new GenState(fn, f);
  o.gen.obj = o;
  f.gen = o;
  return o;
}
