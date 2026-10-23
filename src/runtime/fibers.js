// Fibers. A fiber runs its callable in fiber mode (callFunctionG, see compiler/generator.js): a
// chain of JS generators in which Fiber::suspend() is a yield. The driver below runs that chain
// until it suspends or finishes, and moves the fiber's PHP frames off the call stack while it is
// suspended (and back on resume), so traces and the current frame stay right.

import { Ref } from '../values.js';
import { rt } from './state.js';
import { throwError } from './errors.js';
import { callFunctionG } from './functions.js';
import { resolveCallable } from './callables.js';
import { GenThrow } from './generators.js';
import { nativeClass } from './native-classes.js';

const arg = (args, i) => { const v = args[i]; return v instanceof Ref ? v.v : v === undefined ? null : v; };
const fiberError = (msg) => throwError('FiberError', msg);
// thrown into a suspended fiber that is destroyed: runs its finally blocks, not its catch blocks
export class FiberExit { }

function state(self) { return self.fiber || (self.fiber = { self, status: 'init', gen: null, stack: [], depth: 0, ret: null, threw: false, silence: 0, closing: false }); }

// runs the fiber until it suspends (returns the suspended value) or finishes (returns null)
function drive(self, step) {
  const st = state(self);
  const outer = { fiber: rt.currentFiber, frame: rt.frame, file: rt.file, line: rt.line, depth: rt.depth, len: rt.stack.length, silence: rt.silence };
  rt.silence = st.silence; // the @ operator's state belongs to the fiber
  for (const fr of st.stack) rt.stack.push(fr);
  rt.depth += st.depth;
  if (st.frame) { rt.frame = st.frame; rt.file = st.file; rt.line = st.line; }
  st.stack = [];
  st.status = 'running';
  rt.currentFiber = self;
  rt.suspendedFibers.delete(st);
  const restore = () => {
    st.silence = rt.silence;
    rt.currentFiber = outer.fiber; rt.frame = outer.frame; rt.file = outer.file; rt.line = outer.line; rt.depth = outer.depth; rt.silence = outer.silence;
    rt.stack.length = outer.len;
  };
  let res;
  try { res = step(st.gen); }
  catch (e) {
    st.status = 'terminated';
    restore();
    if (e instanceof FiberExit) return null;
    st.threw = true;
    throw e;
  }
  if (res.done) { st.status = 'terminated'; st.ret = res.value; restore(); return null; }
  st.status = 'suspended';
  st.stack = rt.stack.slice(outer.len);
  st.depth = rt.depth - outer.depth;
  st.frame = rt.frame; st.file = rt.file; st.line = rt.line;
  rt.suspendedFibers.add(st); // its frames stay roots for the destructor GC while suspended
  restore();
  return res.value === undefined ? null : res.value;
}

// at shutdown, unfinished fibers are destroyed: their pending finally blocks run
export function closeFibers() {
  for (const st of [...rt.suspendedFibers]) if (st.status === 'suspended') forceClose(st);
}
function forceClose(st) {
  st.closing = true;
  drive(st.self, (g) => g.throw(new FiberExit()));
}

export function bootFibers() {
  const cls = nativeClass('Fiber', {
    final: true,
    methods: {
      __construct(self, args) {
        if (self.fiber && self.fiber.cb !== undefined) fiberError('Cannot call constructor twice');
        const cb = arg(args, 0);
        try { resolveCallable(cb, rt.frame, true); }
        catch (e) { throwError('TypeError', `Fiber::__construct(): Argument #1 ($callback) must be a valid callback, ${typeof cb === 'string' ? `function "${cb}" not found or invalid function name` : 'no array or string given'}`); }
        state(self).cb = cb;
      },
      start(self, args) {
        const st = state(self);
        if (st.status !== 'init') fiberError('Cannot start a fiber that has already been started');
        const c = resolveCallable(st.cb, rt.frame, true);
        st.gen = callFunctionG(c.fn, args.map((a) => (a instanceof Ref ? a.v : a)), c.thisObj, c.cls, c.sc, c.closure);
        return drive(self, (g) => g.next());
      },
      resume(self, args) {
        const st = state(self);
        if (st.status !== 'suspended') fiberError('Cannot resume a fiber that is not suspended');
        const v = arg(args, 0);
        return drive(self, (g) => g.next(v));
      },
      throw(self, args) {
        const st = state(self);
        if (st.status !== 'suspended') fiberError('Cannot resume a fiber that is not suspended');
        const e = arg(args, 0);
        return drive(self, (g) => g.next(new GenThrow(e)));
      },
      getReturn(self) {
        const st = state(self);
        if (st.status === 'terminated') { if (st.threw) fiberError('Cannot get fiber return value: The fiber threw an exception'); return st.ret; }
        fiberError(`Cannot get fiber return value: The fiber ${st.status === 'init' ? 'has not been started' : 'has not returned'}`);
      },
      isStarted: (self) => state(self).status !== 'init',
      isSuspended: (self) => state(self).status === 'suspended',
      isRunning: (self) => state(self).status === 'running',
      isTerminated: (self) => state(self).status === 'terminated',
      // reached only outside fiber-mode code: from a builtin's callback or a generator body
      'static suspend'() {
        if (!rt.currentFiber) fiberError('Cannot suspend outside of a fiber');
        fiberError('Cannot suspend a fiber from a callback called by a builtin function or from a generator (not supported by NIP)');
      },
      'static getCurrent': () => rt.currentFiber || null,
    },
  });
  cls.methods.get('suspend').fn.suspends = true;
  // destroying a suspended fiber force-closes it
  cls.hasDestructor = true;
  cls.nativeDestruct = (o) => { const st = o.fiber; if (st && st.status === 'suspended') forceClose(st); };
  return cls;
}

