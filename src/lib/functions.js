// Function and class introspection: function_exists, call_user_func, class_exists, get_object_vars, ...

import { cp, normKey, PHPArray, PHPObject } from '../values.js';
import { toBool, typeOf } from '../convert.js';
import { looseEq } from '../compare.js';
import { rt } from '../runtime/state.js';
import { deprecated, PRELUDE_FILE, throwError, warn } from '../runtime/errors.js';
import { FRAME_FUNCS, noDiscardWarn } from '../runtime/functions.js';
import { callValue, invokeCallable, nativeCallback, refCallArgs } from '../runtime/callables.js';
import {
  canAccessMember, classConst, classExists, cloneObject, lookupClass, lookupStaticProp, objVisibleProps,
  propAccessible, propDefault, readonlyKeys, writeProp
} from '../runtime/classes.js';
import { A, def, S } from './core.js';
import { since } from '../runtime/version.js';
import { lazyFnSrc } from '../runtime/boot.js';

def('function_exists', (function_name) => { let n = S(function_name); if (n[0] === '\\') n = n.slice(1); if (rt.disabledFns && rt.disabledFns.has(n.toLowerCase())) return false; return rt.fns.has(n.toLowerCase()) || !!FRAME_FUNCS[n.toLowerCase()] || lazyFnSrc.has(n.toLowerCase()); });
// (a call_user_func() whose result is discarded discards the callback's: #[\NoDiscard])
const discarded = (c, args) => { const d = rt.discardNext; rt.discardNext = false; if (d && c.fn.noDiscard !== undefined) noDiscardWarn(c.fn, args, c.cls); };
def('call_user_func', (callback, ...args) => { const c = nativeCallback(callback); discarded(c, args); return invokeCallable(c, refCallArgs(c, args)); });
def('call_user_func_array', (callback, args) => {
  const a = A(args);
  const pos = []; let named = null;
  for (const [k, v] of a.entries()) { if (typeof k === 'string') { if (!named) named = new Map(); named.set(k, v); } else pos.push(v); }
  const c = nativeCallback(callback);
  discarded(c, pos);
  if (named) pos.named = named;
  refCallArgs(c, pos);
  return invokeCallable(c, pos);
});
// clone() with properties to change (PHP 8.5): assigned in the caller's scope after __clone(),
// readonly ones included
def('clone', (f, object, withProperties = null) => {
  if (!(object instanceof PHPObject)) throwError('TypeError', `clone(): Argument #1 ($object) must be of type object, ${typeOf(object)} given`);
  if (withProperties !== null && !(withProperties instanceof PHPArray)) throwError('TypeError', `clone(): Argument #2 ($withProperties) must be of type array, ${typeOf(withProperties)} given`);
  const c = cloneObject(object, f);
  if (withProperties && withProperties.size) {
    c.reinit = readonlyKeys(c);
    try {
      for (const [k, v] of withProperties.entries()) {
        const name = String(k);
        if (name.charCodeAt(0) === 0 && name.length) throwError('Error', 'Cannot access property starting with "\\0"');
        writeProp(c, name, cp(v), f);
      }
    } finally { c.reinit = undefined; }
  }
  return c;
}, { frame: true });
since(80500, 'fn', 'clone');
def('forward_static_call', (callback, ...args) => callValue(callback, args));
def('forward_static_call_array', (callback, args) => callValue(callback, A(args).values()));
def('get_class', (object = undefined) => {
  if (object === undefined) {
    const f = rt.frame;
    if (f && f.cls) { deprecated('Calling get_class() without arguments is deprecated'); return f.cls.name; }
    throwError('Error', 'get_class() without arguments must be called from within a class');
  }
  if (!(object instanceof PHPObject)) throwError('TypeError', `get_class(): Argument #1 ($object) must be of type object, ${typeOf(object)} given`);
  return object.cls.name;
}, { min: 0 });
def('get_parent_class', (object_or_class = undefined) => {
  let c;
  if (object_or_class === undefined) { deprecated('Calling get_parent_class() without arguments is deprecated'); c = rt.frame ? rt.frame.cls : null; }
  else if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else {
    c = typeof object_or_class === 'string' ? classExists(object_or_class, true) : null;
    if (!c) throwError('TypeError', `get_parent_class(): Argument #1 ($object_or_class) must be an object or a valid class name, ${typeOf(object_or_class)} given`);
  }
  return c && c.parent ? c.parent.name : false;
}, { min: 0 });
def('get_object_vars', (object) => PHPArray.fromPairs(objVisibleProps(object, rt.frame ? rt.frame.cls : null).map(([k, v]) => [normKey(k), cp(v)])));
def('get_class_vars', (class_name) => {
  const c = lookupClass(S(class_name)); const out = new PHPArray(); const scope = rt.frame ? rt.frame.cls : null;
  for (const [, info] of c.slots) if (propAccessible(info, scope) && (info.vis !== 'private' || info.cls === scope)) out.set(info.name, info.hasDef ? cp(propDefault(info)) : null);
  for (const [n, si] of c.sprops) if (propAccessible(si, scope)) out.set(n, cp(lookupStaticProp(c, n).ref.v));
  return out;
});
def('get_class_methods', (object_or_class) => {
  const c = object_or_class instanceof PHPObject ? object_or_class.cls : lookupClass(S(object_or_class));
  const scope = rt.frame ? rt.frame.cls : null;
  return PHPArray.from([...c.methods.values()].filter((m) => canAccessMember(m, scope)).map((m) => m.name));
});
def('method_exists', (object_or_class, method) => {
  let c;
  if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else { c = classExists(S(object_or_class), true); if (!c) return false; }
  return c.methods.has(S(method).toLowerCase());
});
def('property_exists', (object_or_class, property) => {
  const p = S(property);
  if (object_or_class instanceof PHPObject) { if (object_or_class.props.has(p)) return true; return object_or_class.cls.props.has(p) || object_or_class.cls.sprops.has(p) || object_or_class.cls.privProps.has(p); }
  const c = classExists(S(object_or_class), true); if (!c) return false;
  return c.props.has(p) || c.sprops.has(p);
});
def('class_exists', (class_name, autoload = true) => { const c = classExists(S(class_name), toBool(autoload)); return !!c && !c.isInterface && !c.isTrait && !c.isEnum; });
def('interface_exists', (interface_name, autoload = true) => { const c = classExists(S(interface_name), toBool(autoload)); return !!c && c.isInterface; });
def('trait_exists', (trait, autoload = true) => { const c = classExists(S(trait), toBool(autoload)); return !!c && c.isTrait; });
def('enum_exists', (enum_name, autoload = true) => { const c = classExists(S(enum_name), toBool(autoload)); return !!c && c.isEnum; });
def('is_a', (object_or_class, class_name, allow_string = false) => {
  let c;
  if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else if (typeof object_or_class === 'string' && toBool(allow_string)) { c = classExists(object_or_class, true); if (!c) return false; }
  else return false;
  return c.ancestors.has(S(class_name).replace(/^\\/, '').toLowerCase());
});
def('is_subclass_of', (object_or_class, class_name, allow_string = true) => {
  let c;
  if (object_or_class instanceof PHPObject) c = object_or_class.cls;
  else if (typeof object_or_class === 'string' && toBool(allow_string)) { c = classExists(object_or_class, true); if (!c) return false; }
  else return false;
  const t = S(class_name).replace(/^\\/, '').toLowerCase();
  return c.lname !== t && c.ancestors.has(t);
});
def('class_implements', (object_or_class, autoload = true) => {
  const c = object_or_class instanceof PHPObject ? object_or_class.cls : classExists(S(object_or_class), toBool(autoload));
  if (!c) return false;
  const out = new PHPArray();
  for (const a of c.ancestors) { const ac = rt.classes.get(a); if (ac && ac.isInterface) out.set(ac.name, ac.name); }
  return out;
});
def('class_parents', (object_or_class, autoload = true) => {
  let c = object_or_class instanceof PHPObject ? object_or_class.cls : classExists(S(object_or_class), toBool(autoload));
  if (!c) return false;
  const out = new PHPArray(); for (c = c.parent; c; c = c.parent) out.set(c.name, c.name);
  return out;
});
def('class_uses', (object_or_class) => {
  const c = object_or_class instanceof PHPObject ? object_or_class.cls : classExists(S(object_or_class), true);
  if (!c) return false;
  const out = new PHPArray();
  for (const tu of c.decl ? c.decl.traits : []) for (const n of tu.names) { const t = lookupClass(n); out.set(t.name, t.name); }
  return out;
});
const objArg = (fn, v) => { if (!(v instanceof PHPObject)) throwError('TypeError', `${fn}(): Argument #1 ($object) must be of type object, ${typeOf(v)} given`); return v; };
def('spl_object_id', (object) => objArg('spl_object_id', object).id);
def('spl_object_hash', (object) => objArg('spl_object_hash', object).id.toString(16).padStart(32, '0'));
def('spl_autoload_register', (callback = null, _throw = true, prepend = false) => {
  if (callback === null) return true;
  if (toBool(prepend)) rt.autoloaders.unshift(callback); else rt.autoloaders.push(callback);
  return true;
});
def('spl_autoload_unregister', (callback) => { const i = rt.autoloaders.findIndex((c) => looseEq(c, callback) || c === callback); if (i >= 0) { rt.autoloaders.splice(i, 1); return true; } return false; });
def('spl_autoload_functions', () => PHPArray.from(rt.autoloaders.slice()));
// declared classes, interfaces and traits; class_alias() names are listed lowercased
const declared = (pred) => PHPArray.from([...rt.classes].filter(([k, c]) => pred(c) && !c.anon && !(c.isTrait && c.decl && c.decl.file === PRELUDE_FILE)).map(([k, c]) => (k === c.lname ? c.name : k)));
def('get_declared_classes', () => declared((c) => !c.isInterface && !c.isTrait));
def('get_declared_interfaces', () => declared((c) => c.isInterface));
def('get_declared_traits', () => declared((c) => c.isTrait));
def('get_defined_functions', () => {
  const out = new PHPArray(); const internal = new PHPArray(), user = new PHPArray();
  for (const [k, f] of rt.fns) (f.native ? internal : user).push(k);
  out.set('internal', internal); out.set('user', user); return out;
});
def('define', (constant_name, value, case_insensitive = false) => {
  const n = S(constant_name);
  if (n.includes('::')) throwError('ValueError', 'define(): Argument #1 ($constant_name) cannot be a class constant');
  // true/false/null (any case) and __COMPILER_HALT_OFFSET__ can't be defined
  if (rt.consts.has(n) || /^(true|false|null)$/i.test(n) || n === '__COMPILER_HALT_OFFSET__') { warn(`Constant ${n} already defined`); return false; }
  rt.consts.set(n, cp(value));
  if (value !== null && typeof value === 'object') rt.constRoots.push(value);
  return true;
});
def('defined', (constant_name) => {
  const n = S(constant_name);
  if (n.includes('::')) { const [c, k] = n.split('::'); const cls = classExists(c, true); return !!cls && cls.consts.has(k); }
  return rt.consts.has(n.replace(/^\\/, ''));
});
def('constant', (name) => {
  const n = S(name);
  if (n.includes('::')) { const [c, k] = n.split('::'); return classConst(lookupClass(c), k, rt.frame, true); }
  const v = rt.consts.get(n.replace(/^\\/, ''));
  if (v === undefined) throwError('Error', `Undefined constant "${n}"`);
  return v;
});
def('get_defined_constants', (categorize = false) => { const out = new PHPArray(); for (const [k, v] of rt.consts) out.set(k, v); return out; });
