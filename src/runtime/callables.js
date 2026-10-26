// Callables (strings, arrays, closures) and Closure objects.

import { PHPArray, PHPObject, Ref, ThrowSig } from '../values.js';
import { toStr, valueName } from '../convert.js';
import { rt } from './state.js';
import { deprecated, throwError } from './errors.js';
import { callFunction } from './functions.js';
import { canAccessMember, classExists, lookupClass } from './classes.js';
import { argPos, deref } from '../lib/core.js';
import { closureClass } from './native-classes.js';
import { lazyFn } from './boot.js';

// the $arguments array of __call()/__callStatic(): named arguments keep their names
export function magicArgs(args) {
  const a = PHPArray.from(args.map((x) => (x instanceof Ref ? x.v : x)));
  if (args.named) for (const [k, v] of args.named) a.set(k, v instanceof Ref ? v.v : v);
  return a;
}
export function makeClosure(fn, bound, thisObj, scope, sc) {
  const o = new PHPObject(closureClass);
  o.fn = fn; o.bound = bound; o.thisObj = thisObj || null; o.scope = scope || null; o.sc = sc || scope || null;
  return o;
}

export function findMethod(cls, name) { return cls.methods.get(name.toLowerCase()) || null; }

export function resolveCallable(v, f, throwIt) {
  const scope = f ? f.cls : null;
  const fail = (msg) => { if (throwIt) throwError('Error', msg); return null; };
  if (v instanceof PHPObject) {
    if (v.cls === closureClass) return { fn: v.fn, thisObj: v.thisObj, cls: v.scope, sc: v.sc, closure: v };
    const m = v.cls.methods.get('__invoke');
    if (m) return { fn: m.fn, thisObj: v, cls: m.cls, sc: v.cls, closure: null };
    return fail('Object of type ' + v.cls.name + ' is not callable');
  }
  if (typeof v === 'string') {
    let name = v[0] === '\\' ? v.slice(1) : v;
    const dc = name.indexOf('::');
    if (dc > 0) return resolveMethodCallable(name.slice(0, dc), name.slice(dc + 2), f, throwIt);
    const fn = rt.fns.get(name.toLowerCase()) || lazyFn(name.toLowerCase()) || forbiddenDynamic(name.toLowerCase());
    if (!fn) return fail(`Call to undefined function ${name}()`);
    return { fn, thisObj: null, cls: null, sc: null, closure: null };
  }
  if (v instanceof PHPArray) {
    if (v.size !== 2) return fail('Array callback must have exactly two elements');
    if (!v.has(0) || !v.has(1)) return fail('Array callback has to contain indices 0 and 1');
    const a = deref(v.get(0)), b = deref(v.get(1));
    if (typeof b !== 'string') return fail('Second array member is not a valid method');
    if (a instanceof PHPObject) {
      let mname = b;
      let cls = a.cls;
      if (mname.toLowerCase().startsWith('parent::')) {
        cls = (scope || a.cls).parent; mname = mname.slice(8);
        if (cls) deprecated(`Callables of the form ["${a.cls.name}", "${b}"] are deprecated`);
      }
      let m = null;
      if (scope && scope.privMethods) { const pm = scope.privMethods.get(mname.toLowerCase()); if (pm && a.cls.ancestors.has(scope.lname)) m = pm; }
      if (!m) m = cls.methods.get(mname.toLowerCase());
      if (!m || (m.vis !== 'public' && !canAccessMember(m, scope))) {
        const mc = a.cls.methods.get('__call');
        if (mc) return { fn: magicCallFn(mc, mname), thisObj: a, cls: mc.cls, sc: a.cls, closure: null };
        if (m) return fail(`Call to ${m.vis} method ${m.cls.name}::${mname}() from ${scope ? 'scope ' + scope.name : 'global scope'}`);
        return fail(`Call to undefined method ${a.cls.name}::${mname}()`);
      }
      return { fn: m.fn, thisObj: m.static ? null : a, cls: m.cls, sc: a.cls, closure: null };
    }
    if (typeof a === 'string') return resolveMethodCallable(a, b, f, throwIt);
    return fail('First array member is not a valid class name or object');
  }
  return fail(throwIt ? `Value of type ${valueName(v)} is not callable` : '');
}
// the scope-introspecting builtins (compiled inline when called by name) can't be called dynamically
const NO_DYNAMIC = new Set(['compact', 'extract', 'get_defined_vars', 'func_get_args', 'func_num_args', 'func_get_arg']);
const forbidden = new Map();
function forbiddenDynamic(lname) {
  if (!NO_DYNAMIC.has(lname)) return undefined;
  let fn = forbidden.get(lname);
  if (!fn) forbidden.set(lname, fn = { name: lname, min: 0, max: Infinity, native: () => throwError('Error', `Cannot call ${lname}() dynamically`) });
  return fn;
}
function magicCallFn(mc, name) {
  return { native: (thisObj, args) => callFunction(mc.fn, [name, magicArgs(args)], thisObj, mc.cls, thisObj ? thisObj.cls : mc.cls, null), isMethod: true, name: mc.name, refs: null };
}
function resolveMethodCallable(cname, mname, f, throwIt) {
  const scope = f ? f.cls : null;
  const fail = (msg) => { if (throwIt) throwError('Error', msg); return null; };
  let cls;
  const lc = cname.toLowerCase();
  if (lc === 'self') cls = scope;
  else if (lc === 'static') cls = f ? f.sc : null;
  else if (lc === 'parent') cls = scope ? scope.parent : null;
  else cls = lookupClass(cname, !throwIt);
  if (!cls) return fail(`Class "${cname}" not found`);
  if (lc === 'self' || lc === 'static' || lc === 'parent') deprecated(`Use of "${lc}" in callables is deprecated`);
  if (mname.toLowerCase().startsWith('parent::')) {
    const org = cls;
    cls = cls.parent; mname = mname.slice(8);
    if (!cls) return fail(`Class "${cname}" not found`);
    deprecated(`Callables of the form ["${org.name}", "${mname === '' ? '' : 'parent::' + mname}"] are deprecated`);
  }
  const m = cls.methods.get(mname.toLowerCase());
  if (!m) {
    const mc = cls.methods.get('__call');
    if (mc && f && f.this && f.this.cls.ancestors.has(cls.lname)) return { fn: magicCallFn(mc, mname), thisObj: f.this, cls: mc.cls, sc: f.this.cls, closure: null };
    const ms = cls.methods.get('__callstatic');
    if (ms) return { fn: { native: (t, args) => callFunction(ms.fn, [mname, magicArgs(args)], null, ms.cls, cls, null), isMethod: true, name: mname, refs: null }, thisObj: null, cls, sc: cls, closure: null };
    return fail(`Call to undefined method ${cls.name}::${mname}()`);
  }
  if (m.vis !== 'public' && !canAccessMember(m, scope)) return fail(`Call to ${m.vis} method ${m.cls.name}::${mname}() from ${scope ? 'scope ' + scope.name : 'global scope'}`);
  if (!m.static) {
    if (f && f.this && f.this.cls.ancestors.has(cls.lname)) return { fn: m.fn, thisObj: f.this, cls: m.cls, sc: f.this.cls, closure: null };
    return fail(`Non-static method ${cls.name}::${m.name}() cannot be called statically`);
  }
  const sc = (lc === 'parent' || lc === 'self') && f && f.sc ? f.sc : cls;
  return { fn: m.fn, thisObj: null, cls: m.cls, sc, closure: null };
}
export function invokeCallable(c, args) { return callFunction(c.fn, args, c.thisObj, c.cls, c.sc, c.closure); }
export function isCallable(v, f) {
  if (v instanceof PHPObject) return v.cls === closureClass || v.cls.methods.has('__invoke');
  if (typeof v !== 'string' && !(v instanceof PHPArray)) return false;
  try { return !!resolveCallable(v, f || rt.frame, false); } catch (e) { if (e instanceof ThrowSig) return false; throw e; }
}
// call a PHP callable from native code; args are plain values (or Refs for by-ref params)
export function callValue(cb, args) {
  const c = resolveCallable(cb, rt.frame, true);
  return callFunction(c.fn, args, c.thisObj, c.cls, c.sc, c.closure);
}
// a callback argument of a builtin: an invalid one is a TypeError naming the argument
export function nativeCallback(cb) {
  if (!rt.nativeName) return resolveCallable(cb, rt.frame, true);
  let c = null;
  try { c = resolveCallable(cb, rt.frame, false); } catch (e) { if (!(e instanceof ThrowSig)) throw e; }
  if (c) return c;
  let reason;
  const relative = (cn) => {
    const lc = cn.toLowerCase(), scope = rt.frame ? rt.frame.cls : null;
    if ((lc === 'self' || lc === 'static') && !scope) return `cannot access "${lc}" when no class scope is active`;
    if (lc === 'parent') return !scope ? 'cannot access "parent" when no class scope is active' : !scope.parent ? 'cannot access "parent" when current class scope has no parent' : null;
    return null;
  };
  if (typeof cb === 'string') reason = cb.includes('::') ? relative(cb.split('::')[0]) || `class "${cb.split('::')[0]}" not found or invalid method name` : `function "${cb}" not found or invalid function name`;
  else if (cb instanceof PHPArray) {
    if (cb.size !== 2) reason = 'array callback must have exactly two members';
    else { const o = cb.get(0), m = cb.get(1); const cn = o instanceof PHPObject ? o.cls.name : toStr(o); const cls = o instanceof PHPObject ? o.cls : classExists(cn, true); reason = (!(o instanceof PHPObject) && relative(cn)) || (!cls ? `class "${cn}" not found` : `class ${cls.name} does not have a method "${toStr(m)}"`); }
  } else reason = 'no array or string given';
  const i = argPos(cb);
  const fn = rt.fns.get(rt.nativeName.toLowerCase());
  const pn = fn && fn.pnames ? fn.pnames[i] : null;
  const orNull = rt.nativeName === 'array_map' ? ' or null' : '';
  throwError('TypeError', `${rt.nativeName}(): Argument #${i + 1}${pn ? ' ($' + pn + ')' : ''} must be a valid callback${orNull}, ${reason}`);
}
// a callback resolved now (self:: and parent:: refer to the current scope) for a later call
export function boundCallback(cb) {
  if (cb instanceof PHPObject) return cb;
  const c = nativeCallback(cb);
  return makeClosure(c.fn, null, c.thisObj, c.cls, c.sc);
}
export function callableFn(cb) { // returns a JS function for repeated invocation
  const c = nativeCallback(cb);
  return (...args) => callFunction(c.fn, args, c.thisObj, c.cls, c.sc, c.closure);
}
export function callableToClosure(v, f) {
  if (v instanceof PHPObject && v.cls === closureClass) return v;
  const c = resolveCallable(v, f, true);
  return makeClosure(c.fn, null, c.thisObj, c.cls, c.sc);
}
export function methodClosure(o, name, f) {
  const c = resolveCallable(PHPArray.from([o, name]), f, true);
  return makeClosure(c.fn, null, c.thisObj, c.cls, c.sc);
}
export function callableName(v) {
  if (typeof v === 'string') return v;
  if (v instanceof PHPArray) { const a = v.get(0); return (a instanceof PHPObject ? a.cls.name : toStr(a)) + '::' + toStr(v.get(1)); }
  if (v instanceof PHPObject) return v.cls === closureClass ? 'Closure::__invoke' : v.cls.name + '::__invoke';
  return '';
}
