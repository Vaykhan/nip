// Classes implemented natively in JS: stdClass, Closure, Generator, WeakReference.

import { cp, PHPArray, PHPObject, Ref } from '../values.js';
import { typeOf } from '../convert.js';
import { rt } from './state.js';
import { throwError, warn } from './errors.js';
import { callFunction } from './functions.js';
import { callableToClosure, makeClosure } from './callables.js';
import { addInterface, inheritFrom, lookupClass, PHPClass } from './classes.js';
import { bootFibers } from './fibers.js';
import { pnamesOf } from '../lib/core.js';

export const PHP_VERSION = '8.3.6';
// set by bootNativeClasses()
export let closureClass = null, generatorClass = null;

export function nativeClass(name, opts = {}) {
  const cls = new PHPClass(name);
  if (opts.parent) inheritFrom(cls, rt.classes.get(opts.parent.toLowerCase()));
  for (const i of opts.interfaces || []) addInterface(cls, rt.classes.get(i.toLowerCase()));
  cls.final = !!opts.final; cls.abstract = !!opts.abstract;
  for (const [mname, fn] of Object.entries(opts.methods || {})) {
    const isStatic = mname.startsWith('static ');
    const n = isStatic ? mname.slice(7) : mname;
    cls.methods.set(n.toLowerCase(), { name: n, cls, vis: 'public', static: isStatic, abstract: false, final: false, fn: { native: fn, isMethod: true, name: n, refs: null, cls } });
  }
  rt.classes.set(cls.lname, cls);
  return cls;
}
function argv0(args, i) { const v = args[i]; return v instanceof Ref ? v.v : (v === undefined ? undefined : v); }

export function bootNativeClasses() {
  nativeClass('stdClass').allowDynamic = true;
  closureClass = nativeClass('Closure', {
    final: true,
    methods: {
      __invoke: (self, args) => callFunction(self.fn, args, self.thisObj, self.scope, self.sc, self),
      call: (self, args) => {
        const nt = argv0(args, 0);
        if (!(nt instanceof PHPObject)) throwError('TypeError', `Closure::call(): Argument #1 ($newThis) must be of type object, ${typeOf(nt)} given`);
        return callFunction(self.fn, args.slice(1), nt, nt.cls, nt.cls, self);
      },
      bindTo: (self, args) => closureBind(self, argv0(args, 0), args.length > 1 ? argv0(args, 1) : 'static'),
      'static bind': (self, args) => closureBind(argv0(args, 0), argv0(args, 1), args.length > 2 ? argv0(args, 2) : 'static'),
      'static fromCallable': (self, args) => callableToClosure(argv0(args, 0), rt.frame),
    },
  });
  closureClass.nativeDebug = closureDebug;
  generatorClass = nativeClass('Generator', {
    final: true, interfaces: ['Iterator'],
    methods: {
      current: (self) => { self.gen.ensure(); return self.gen.done ? null : self.gen.cur; },
      key: (self) => { self.gen.ensure(); return self.gen.done ? null : self.gen.key; },
      next: (self) => { self.gen.next(); return null; },
      valid: (self) => { self.gen.ensure(); return !self.gen.done; },
      rewind: (self) => { const g = self.gen; g.ensure(); if (g.advanced) throwError('Exception', 'Cannot rewind a generator that was already run'); return null; },
      send: (self, args) => self.gen.send(argv0(args, 0) === undefined ? null : argv0(args, 0)),
      throw: (self, args) => self.gen.throwIn(argv0(args, 0)),
      getReturn: (self) => {
        const g = self.gen;
        if (!g.done) throwError('Exception', "Cannot get return value of a generator that hasn't returned");
        return g.ret;
      },
    },
  });
  nativeClass('__PHP_Incomplete_Class').allowDynamic = true;
  bootFibers();
  const weakRef = nativeClass('WeakReference', {
    final: true,
    methods: {
      'static create': (self, args) => { const o = new PHPObject(rt.classes.get('weakreference')); o.target = argv0(args, 0); return o; },
      get: (self) => (self.target && !self.target.idFreed ? self.target : null), // freed objects are gone
    },
  });
  for (const c of [closureClass, generatorClass, weakRef, rt.classes.get('fiber')]) c.noDynamic = true;
}
// var_dump() of a closure (zend_closure_get_debug_info): its used and static variables, $this, and
// its parameters
function closureDebug(o) {
  const out = [];
  const fn = o.fn;
  // closures made from a callable (Closure::fromCallable(), strlen(...)) show the function
  if (!fn.isClosure) out.push(['function', fn.isMethod && fn.cls ? fn.cls.name + '::' + fn.name : fn.name]);
  const statics = new PHPArray();
  if (o.bound) for (const [k, v] of o.bound) statics.set(k, v instanceof Ref ? v : cp(v));
  if (fn.decl && fn.decl.body) {
    for (const sv of staticDecls(fn)) {
      const r = o.statics && o.statics.get(sv.name);
      statics.set(sv.name, r ? r : sv.init && sv.init.k === 'Lit' ? sv.init.v : null);
    }
  }
  if (statics.size) out.push(['static', statics]);
  if (o.thisObj) out.push(['this', o.thisObj]);
  if (fn.native !== undefined && typeof fn.native === 'function' && !fn.isMethod) {
    const names = fn.pnames || pnamesOf(fn.native);
    if (names.length) {
      const ps = new PHPArray();
      names.forEach((name, i) => ps.set((fn.refs && fn.refs[i] ? '&$' : '$') + name, i >= fn.min ? '<optional>' : '<required>'));
      out.push(['parameter', ps]);
    }
  } else if (fn.params && fn.params.length) {
    const ps = new PHPArray();
    const required = fn.required ?? fn.params.length;
    fn.params.forEach((p, i) => ps.set((p.byRef ? '&$' : '$') + p.name, i >= required || p.variadic ? '<optional>' : '<required>'));
    out.push(['parameter', ps]);
  }
  return out;
}
// the `static $x` declarations in a function's body (not in nested functions or classes)
function staticDecls(fn) {
  if (fn.staticDecls) return fn.staticDecls;
  const found = [];
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.k === 'StaticVar') { found.push(...n.vars); return; }
    if (n.k === 'Closure' || n.k === 'ClassDecl' || n.k === 'FuncDecl') return;
    for (const key in n) if (key !== 'l' && n[key] && typeof n[key] === 'object') walk(n[key]);
  };
  walk(fn.decl.body);
  return (fn.staticDecls = found);
}
function closureBind(cl, newThis, newScope) {
  if (!(cl instanceof PHPObject) || cl.cls !== closureClass) throwError('TypeError', 'Closure::bind(): Argument #1 ($closure) must be of type Closure');
  let scope = cl.scope;
  if (newScope instanceof PHPObject) scope = newScope.cls;
  else if (typeof newScope === 'string' && newScope !== 'static') scope = lookupClass(newScope);
  else if (newScope === null) scope = null;
  if (newThis !== null && newThis !== undefined && !(newThis instanceof PHPObject)) throwError('TypeError', 'Closure::bind(): Argument #2 ($newThis) must be of type ?object');
  if (cl.fn.decl && cl.fn.decl.static && newThis) { warn('Cannot bind an instance to a static closure'); newThis = null; }
  const o = makeClosure(cl.fn, cl.bound, newThis || null, scope, newThis ? newThis.cls : scope);
  return o;
}
