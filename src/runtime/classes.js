// Classes and objects: declaration, inheritance, traits, enums, property and method access.

import { cp, FatalSig, isInt, NOREF, normKey, PHPArray, PHPObject, Ref, ThrowSig } from '../values.js';
import { toBool, toStr, typeOf } from '../convert.js';
import { isNum, looseEq } from '../compare.js';
import { Frame, writableArrIn } from '../compiler/common.js';
import { cExpr } from '../compiler/expr.js';
import { rt } from './state.js';
import { initThrowable, notice, PRELUDE_FILE, throwError, warn } from './errors.js';
import { callFunction, coercePropType, coerceType, compileFunction, FAIL, typeStr, valueName } from './functions.js';
import { callValue } from './callables.js';
import { gcCheck, gcCollect } from './gc.js';
import { closureClass, generatorClass } from './native-classes.js';
import { lazyClass, lazyClassSrc } from './boot.js';

export class PHPClass {
  constructor(name) {
    this.name = name; this.lname = name.toLowerCase();
    this.parent = null; this.kind = 'class'; this.abstract = false; this.final = false; this.anon = false;
    this.isInterface = false; this.isTrait = false; this.isEnum = false; this.readonly = false;
    this.ancestors = new Set([this.lname]); this.ifaceList = [];
    this.consts = new Map(); this.sprops = new Map(); this.props = new Map(); this.privProps = new Map(); this.slots = new Map();
    this.methods = new Map(); this.privMethods = null;
    this.enumBacked = null; this.decl = null; this.nativeIter = null; this.toBoolHook = null; this.hasDestructor = false;
    this.propInit = null;
    this.hasInternal = false; // has prelude-internal properties, see isInternalSlot()
  }
}

// Members of classes written in src/prelude/*.php whose names start with "__" (other than PHP's
// magic methods) are implementation details: they are left out of property listings, dumps,
// casts, comparisons and Reflection, as if they were C-level state of an internal class.
const MAGIC_METHODS = new Set(['__construct', '__destruct', '__call', '__callstatic', '__get', '__set', '__isset', '__unset',
  '__sleep', '__wakeup', '__serialize', '__unserialize', '__tostring', '__invoke', '__set_state', '__clone', '__debuginfo']);
export function isInternalName(owner, name) {
  return name.charCodeAt(0) === 95 && name.charCodeAt(1) === 95 && !!owner.decl && owner.decl.file === PRELUDE_FILE && !MAGIC_METHODS.has(name.toLowerCase());
}
export function isInternalSlot(cls, key) { if (!cls.hasInternal) return false; const s = cls.slots.get(key); return s !== undefined && s.internal === true; }
// [key, value-or-Ref] pairs of an object's properties without the internal ones
export function objectProps(o) {
  if (!o.cls.hasInternal) return [...o.props];
  const out = [];
  for (const e of o.props) if (!isInternalSlot(o.cls, e[0])) out.push(e);
  return out;
}
// The properties PHP shows for an internal class in var_dump/print_r/var_export, (array) casts and
// json_encode, which a prelude class can compute with __nipProps(). null when it doesn't.
export function nipProps(o) {
  const m = o.cls.methods.get('__nipprops');
  if (m === undefined) return null;
  const r = callFunction(m.fn, [], o, m.cls, o.cls, null);
  return r instanceof PHPArray ? r : new PHPArray();
}

export function lookupClass(name, quiet) {
  if (name instanceof PHPClass) return name;
  let n = name[0] === '\\' ? name.slice(1) : name;
  const ln = n.toLowerCase();
  let c = rt.classes.get(ln);
  if (c !== undefined) return c;
  if (lazyClassSrc.has(ln)) { c = lazyClass(ln); if (c) return c; }
  // autoload
  if (rt.autoloaders.length && !rt.autoloading?.has(ln)) {
    if (!rt.autoloading) rt.autoloading = new Set();
    rt.autoloading.add(ln);
    try {
      for (const al of rt.autoloaders) {
        callValue(al, [n]);
        c = rt.classes.get(ln);
        if (c) return c;
      }
    } finally { rt.autoloading.delete(ln); }
  }
  if (quiet) return null;
  throwError('Error', `Class "${n}" not found`);
}
export function classExists(name, autoload) {
  const ln = (name[0] === '\\' ? name.slice(1) : name).toLowerCase();
  if (rt.classes.has(ln)) return rt.classes.get(ln);
  if (lazyClassSrc.has(ln)) { const c = lazyClass(ln); if (c) return c; }
  if (autoload) return lookupClass(name, true);
  return null;
}

function constFrame(cls) { const f = new Frame(null, null, cls, cls); return f; }

export function canAccessMember(m, scope) {
  if (m.vis === 'public') return true;
  if (!scope) return false;
  if (m.vis === 'private') return scope === m.cls;
  return scope.ancestors.has(m.cls.lname) || m.cls.ancestors.has(scope.lname) || (m.proto && scope.ancestors.has(m.proto.lname));
}

let anonSerial = 0;
export const displayName = (cls) => { const i = cls.name.indexOf('\0'); return i < 0 ? cls.name : cls.name.slice(0, i); };
export function declareClass(decl, f) {
  const lname = decl.name.toLowerCase();
  if (!decl.anon && rt.classes.has(lname)) {
    const ex = rt.classes.get(lname);
    if (ex.decl === decl) return ex;
    throw new FatalSig(`Cannot declare ${decl.kind} ${decl.name}, because the name is already in use`, decl.l, decl.file);
  }
  const cls = new PHPClass(decl.anon ? `${decl.parent || decl.interfaces[0] || 'class'}@anonymous\0${decl.file}:${decl.l}$${(anonSerial++).toString(16)}` : decl.name);
  if (decl.anon) { cls.anon = true; cls.ancestors = new Set([cls.lname]); }
  cls.decl = decl; cls.kind = decl.kind;
  cls.abstract = decl.flags.abstract; cls.final = decl.flags.final; cls.readonly = decl.flags.readonly;
  cls.isInterface = decl.kind === 'interface'; cls.isTrait = decl.kind === 'trait'; cls.isEnum = decl.kind === 'enum';
  const savedLine = rt.line, savedFile = rt.file;
  rt.line = decl.l; rt.file = decl.file;
  try {
    // parent
    if (decl.parent) {
      const p = lookupClass(decl.parent);
      if (p.isInterface) throw new FatalSig(`Class ${cls.name} cannot extend interface ${p.name}`, decl.l, decl.file);
      if (p.isTrait) throw new FatalSig(`Class ${cls.name} cannot extend trait ${p.name}`, decl.l, decl.file);
      if (p.final) throw new FatalSig(`Class ${cls.name} cannot extend final class ${p.name}`, decl.l, decl.file);
      inheritFrom(cls, p);
    }
    // interfaces
    for (const iname of decl.interfaces) {
      const ic = lookupClass(iname);
      if (!ic.isInterface) throw new FatalSig(`${cls.name} cannot implement ${ic.name} - it is not an interface`, decl.l, decl.file);
      addInterface(cls, ic);
    }
    if (cls.isEnum) {
      addInterface(cls, rt.classes.get('unitenum'));
      if (decl.enumType) addInterface(cls, rt.classes.get('backedenum'));
    }
    // traits
    for (const tu of decl.traits) useTraits(cls, tu, f);
    // constants
    for (const c of decl.consts) {
      const ex = cls.consts.get(c.name);
      if (ex && ex.final && ex.cls !== cls) throw new FatalSig(`${cls.name}::${c.name} cannot override final constant ${ex.cls.name}::${c.name}`, c.l, decl.file);
      cls.consts.set(c.name, { E: cExpr(c.e), val: undefined, done: false, cls, vis: c.vis, final: c.final, decl: c });
    }
    // enum cases
    if (cls.isEnum) {
      cls.enumBacked = decl.enumType ? decl.enumType.alts[0] : null;
      cls.cases = [];
      for (const c of decl.cases) {
        const E = c.e ? cExpr(c.e) : null;
        const entry = { case: true, val: undefined, done: false, cls, vis: 'public', name: c.name, E: null, decl: c };
        entry.make = () => {
          const o = new PHPObject(cls);
          o.props.set('name', c.name);
          if (E) o.props.set('value', E(constFrame(cls)));
          return o;
        };
        cls.consts.set(c.name, entry);
        cls.cases.push(c.name);
      }
      cls.props.set('name', { name: 'name', key: 'name', cls, vis: 'public', type: { alts: ['string'], nullable: false }, readonly: true, hasDef: false });
      if (cls.enumBacked) cls.props.set('value', { name: 'value', key: 'value', cls, vis: 'public', type: { alts: [cls.enumBacked], nullable: false }, readonly: true, hasDef: false });
      addEnumMethods(cls);
    }
    // properties
    for (const p of decl.props) addProp(cls, p, cls);
    // methods
    for (const m of decl.methods) addMethod(cls, m.fn, m, cls);
    // promoted ctor params
    const ctor = decl.methods.find((m) => m.fn.name.toLowerCase() === '__construct');
    if (ctor) for (const prm of ctor.fn.params) if (prm.promote) addProp(cls, { name: prm.name, def: null, hasDef: false, static: false, vis: prm.promote, type: prm.type, promoted: true, attrs: prm.attrs, l: ctor.l, readonly: prm.readonly || cls.readonly }, cls);
    // abstract check
    if (!cls.abstract && !cls.isInterface && !cls.isTrait) {
      const abs = [...cls.methods.values()].filter((m) => m.abstract);
      if (abs.length) throw new FatalSig(`Class ${cls.name} contains ${abs.length} abstract method${abs.length > 1 ? 's' : ''} and must therefore be declared abstract or implement the remaining methods (${abs.map((m) => m.cls.name + '::' + m.name).join(', ')})`, decl.l, decl.file);
    }
    if (cls.parent || decl.traits.length) {
      const own = new Map(), rest = [];
      for (const [k, m] of cls.methods) { if (m.cls === cls) own.set(k, m); else rest.push([k, m]); }
      for (const [k, m] of rest) own.set(k, m);
      cls.methods = own;
    }
    if (cls.methods.has('__tostring')) cls.ancestors.add('stringable');
    cls.hasDestructor = cls.methods.has('__destruct');
    if (!decl.anon) { rt.classes.set(lname, cls); decl.declared = true; }
  } finally { rt.line = savedLine; rt.file = savedFile; }
  return cls;
}

export function inheritFrom(cls, p) {
  cls.parent = p;
  for (const a of p.ancestors) cls.ancestors.add(a);
  cls.ifaceList.push(...p.ifaceList);
  for (const [k, v] of p.consts) cls.consts.set(k, v);
  for (const [k, v] of p.sprops) cls.sprops.set(k, v);
  for (const [k, v] of p.props) if (v.vis !== 'private') cls.props.set(k, v);
  for (const [k, v] of p.slots) cls.slots.set(k, v);
  cls.hasInternal = p.hasInternal;
  for (const [k, v] of p.methods) cls.methods.set(k, v);
  cls.nativeIter = p.nativeIter; cls.toBoolHook = p.toBoolHook;
  if (p.nativeCtor) cls.nativeCtor = p.nativeCtor;
}
export function addInterface(cls, ic) {
  for (const a of ic.ancestors) cls.ancestors.add(a);
  cls.ifaceList.push(ic);
  for (const [k, v] of ic.consts) if (!cls.consts.has(k)) cls.consts.set(k, v);
  for (const [k, m] of ic.methods) if (!cls.methods.has(k)) cls.methods.set(k, m);
}
function addProp(cls, p, owner) {
  const info = {
    name: p.name, key: p.vis === 'private' && !p.static ? `\0${owner.name}\0${p.name}` : p.name, cls: owner, vis: p.vis,
    type: p.type || null, readonly: !!p.readonly, hasDef: !!p.hasDef, defE: p.hasDef ? (p.defE || cExpr(p.def)) : null, val: undefined, evaluated: false, decl: p,
    internal: isInternalName(owner, p.name),
  };
  if (info.internal) cls.hasInternal = true;
  if (info.type && info.hasDef && p.def && p.def.k === 'Lit' && p.def.v === null && !info.type.nullable && !info.type.alts.includes('mixed')) { /* PHP: compile error; be lenient */ info.type = { alts: info.type.alts, nullable: true }; }
  if (p.static) {
    const si = { name: p.name, cls: owner, vis: p.vis, type: info.type, readonly: info.readonly, ref: new Ref(null), pending: info.hasDef, defE: info.defE, decl: p, hasDef: info.hasDef, internal: info.internal };
    if (!info.hasDef && info.type && !info.type.nullable) si.uninit = true;
    cls.sprops.set(p.name, si);
    return;
  }
  if (p.vis === 'private') {
    cls.privProps.set(p.name, info);
    cls.props.set(p.name, info);
    cls.slots.set(info.key, info);
    // a private redeclaration hides the parent's public/protected slot from this class's own scope
    if (cls.slots.has(p.name) && cls.slots.get(p.name).cls !== owner) { /* keep parent slot */ }
  } else {
    const ex = cls.props.get(p.name);
    if (ex && ex.vis === 'private' && ex.cls === owner) cls.slots.delete(ex.key);
    cls.props.set(p.name, info);
    cls.slots.set(info.key, info);
  }
  cls.propInit = null;
}
function addMethod(cls, decl, m, owner, alias) {
  const name = alias || decl.name;
  const lname = name.toLowerCase();
  const ex = cls.methods.get(lname);
  if (ex && ex.final && ex.cls !== owner && !ex.abstract) throw new FatalSig(`Cannot override final method ${ex.cls.name}::${ex.name}()`, m.l || decl.l, decl.file);
  if (ex && !m.abstract && ex.abstract === false && m.abstract) return;
  if (m.abstract && ex && !ex.abstract) return; // keep concrete implementation (e.g. from trait/parent)
  const fn = compileFunction(decl, { method: true, cls: owner });
  fn.name = name;
  if (lname === '__tostring' && !fn.ret) fn.ret = { alts: ['string'], nullable: false };
  const method = { name, fn, cls: owner, vis: m.vis, static: m.static, abstract: m.abstract || !decl.body, final: m.final, proto: ex && ex.vis !== 'private' && (lname !== '__construct' || ex.abstract) ? (ex.proto || ex.cls) : null };
  if (decl.body === null && !cls.isInterface && !m.abstract) method.abstract = true;
  cls.methods.set(lname, method);
  if (m.vis === 'private') { if (!cls.privMethods) cls.privMethods = new Map(); cls.privMethods.set(lname, method); }
}
function useTraits(cls, tu, f) {
  const traits = tu.names.map((n) => {
    const t = lookupClass(n);
    if (!t.isTrait) throw new FatalSig(`${cls.name} cannot use ${t.name} - it is not a trait`, cls.decl.l, cls.decl.file);
    return t;
  });
  const excluded = new Map(); // lname -> Set of trait lnames excluded
  for (const r of tu.rules) if (r.kind === 'insteadof') for (const ex of r.excl) {
    const k = r.method.toLowerCase();
    if (!excluded.has(k)) excluded.set(k, new Set());
    excluded.get(k).add(ex.toLowerCase());
  }
  for (const t of traits) {
    for (const [ln, m] of t.methods) {
      if (excluded.has(ln) && excluded.get(ln).has(t.lname)) continue;
      const ownDefined = cls.decl.methods.some((om) => om.fn.name.toLowerCase() === ln);
      if (!ownDefined) {
        let vis = m.vis;
        for (const r of tu.rules) if (r.kind === 'as' && !r.alias && r.method.toLowerCase() === ln && (!r.trait || r.trait.toLowerCase() === t.lname) && r.vis) vis = r.vis;
        const ex = cls.methods.get(ln);
        if (!(m.abstract && ex && !ex.abstract)) addMethod(cls, m.fn.decl, { vis, static: m.static, abstract: m.abstract, final: m.final }, cls);
      }
      for (const r of tu.rules) {
        if (r.kind === 'as' && r.alias && r.method.toLowerCase() === ln && (!r.trait || r.trait.toLowerCase() === t.lname)) {
          addMethod(cls, m.fn.decl, { vis: r.vis || m.vis, static: m.static, abstract: m.abstract, final: m.final }, cls, r.alias);
        }
      }
    }
    for (const [, info] of t.slots) addProp(cls, Object.assign({}, info.decl, { defE: info.defE }), cls);
    for (const [, si] of t.sprops) addProp(cls, { name: si.name, def: null, hasDef: !!si.defE, defE: si.defE, static: true, vis: si.vis, type: si.type, readonly: si.readonly }, cls);
    for (const [k, c] of t.consts) if (!cls.consts.has(k)) cls.consts.set(k, { E: c.E, val: undefined, done: false, cls, vis: c.vis });
    for (const a of t.traitIfaces || []) cls.ancestors.add(a);
  }
}

function addEnumMethods(cls) {
  const mk = (name, native, isStatic = true) => cls.methods.set(name.toLowerCase(), { name, cls, vis: 'public', static: isStatic, abstract: false, final: false, fn: { native, isMethod: true, name, refs: null, cls } });
  mk('cases', () => PHPArray.from(cls.cases.map((n) => classConst(cls, n))));
  if (cls.enumBacked) {
    const find = (v) => {
      for (const n of cls.cases) { const o = classConst(cls, n); const cv = o.props.get('value'); if (looseEq(cv, v) && (typeof cv === typeof v || isNum(cv) === isNum(v))) return o; }
      return null;
    };
    const norm = (v) => {
      if (cls.enumBacked === 'int') {
        if (isInt(v)) return v;
        const r = coerceType({ alts: ['int'], nullable: false }, v, false, null);
        if (r === FAIL) throwError('TypeError', `${cls.name}::from(): Argument #1 ($value) must be of type int, ${typeOf(v)} given`);
        return r;
      }
      return toStr(v);
    };
    mk('from', (t, args) => {
      const v = norm(args[0] instanceof Ref ? args[0].v : args[0]);
      const r = find(v);
      if (!r) throwError('ValueError', `${typeof v === 'string' ? '"' + v + '"' : toStr(v)} is not a valid backing value for enum ${cls.name.includes('\\') ? cls.name : cls.name}`);
      return r;
    });
    mk('tryFrom', (t, args) => find(norm(args[0] instanceof Ref ? args[0].v : args[0])));
  }
}

export function classConst(cls, name, f) {
  const c = cls.consts.get(name);
  if (c === undefined) throwError('Error', `Undefined constant ${cls.name}::${name}`);
  if (c.vis === 'private' && f && f.cls !== c.cls) throwError('Error', `Cannot access private constant ${cls.name}::${name}`);
  if (!c.done) {
    if (c.evaluating) throwError('Error', `Cannot declare self-referencing constant ${c.cls.name}::${name}`);
    c.evaluating = true;
    try {
      c.val = c.case ? c.make() : c.E(constFrame(c.cls));
      // typed class constants (PHP 8.3) are checked strictly
      const t = c.decl && c.decl.type;
      if (t && coerceType(t, c.val, true, { cls: c.cls, sc: c.cls }) === FAIL) throwError('TypeError', `Cannot assign ${valueName(c.val)} to class constant ${c.cls.name}::${name} of type ${typeStr(t, c.cls)}`);
    } finally { c.evaluating = false; }
    c.done = true;
    if (c.val instanceof PHPArray) c.val.cow = true;
  }
  return c.val;
}

export function lookupStaticProp(cls, name) {
  const si = cls.sprops.get(name);
  if (!si) return null;
  if (si.pending) { si.pending = false; si.ref.v = cp(si.defE(constFrame(si.cls))); }
  return si;
}
export function findStaticProp(cls, name, f) {
  const si = lookupStaticProp(cls, name);
  if (!si) throwError('Error', `Access to undeclared static property ${cls.name}::$${name}`);
  if (si.vis !== 'public' && !canAccessMember(si, f ? f.cls : null)) throwError('Error', `Cannot access ${si.vis} property ${cls.name}::$${name}`);
  if (si.uninit) { if (si.ref.v === null) { /* allow writes */ } }
  return si;
}

export function propDefault(info) {
  if (!info.evaluated) { info.val = info.defE(constFrame(info.cls)); info.evaluated = true; if (info.val instanceof PHPArray) info.val.cow = true; }
  return info.val;
}
export function initProps(obj) {
  const cls = obj.cls;
  let pi = cls.propInit;
  if (pi === null) {
    pi = [];
    for (const info of cls.slots.values()) {
      if (info.hasDef) pi.push([info.key, propDefault(info)]);
      else if (!info.type) pi.push([info.key, null]);
    }
    cls.propInit = pi;
  }
  const props = obj.props;
  for (let i = 0; i < pi.length; i++) { const v = pi[i][1]; if (v instanceof PHPArray) v.cow = true; props.set(pi[i][0], v); }
}

export function instantiate(cls, A, f) {
  if (cls.abstract || cls.isInterface || cls.isTrait || cls.isEnum) {
    const what = cls.isInterface ? 'interface' : cls.isTrait ? 'trait' : cls.isEnum ? 'enum' : 'abstract class';
    throwError('Error', `Cannot instantiate ${what} ${cls.name}`);
  }
  const obj = new PHPObject(cls);
  initProps(obj);
  if (cls.ancestors.has('throwable')) initThrowable(obj);
  const ctor = cls.methods.get('__construct');
  if (ctor) {
    if (ctor.vis !== 'public' && !canAccessMember(ctor, f ? f.cls : null)) throwError('Error', `Call to ${ctor.vis} ${cls.name}::__construct() from ${f && f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
    const args = A ? A(f, ctor.fn) : [];
    if (cls.hasDestructor) {
      try { callFunction(ctor.fn, args, obj, ctor.cls, cls, null); }
      catch (e) { if (e instanceof ThrowSig) { trackDestructible(obj); gcCollect([obj], [e.obj]); } throw e; }
    } else callFunction(ctor.fn, args, obj, ctor.cls, cls, null);
  } else if (A) A(f, null);
  if (cls.hasDestructor && !rt.destructibles.includes(obj)) trackDestructible(obj);
  return obj;
}
function trackDestructible(obj) {
  rt.destructibles.push(obj);
  const fr = rt.frame;
  if (fr && fr !== rt.globalFrame) (fr.destr || (fr.destr = [])).push(obj);
}

export function callMethodName(obj, name, args) {
  const m = obj.cls.methods.get(name.toLowerCase());
  if (!m) {
    const mc = obj.cls.methods.get('__call');
    if (mc) return callFunction(mc.fn, [name, PHPArray.from(args)], obj, mc.cls, obj.cls, null);
    throwError('Error', `Call to undefined method ${obj.cls.name}::${name}()`);
  }
  return callFunction(m.fn, args, m.static ? null : obj, m.cls, obj.cls, null);
}
export function callMethod(obj, m, args) { return callFunction(m.fn, args, obj, m.cls, obj.cls, null); }

// ---------------------------------------------------------------- property access
function propInfoFor(obj, name, scope) {
  if (scope !== null && scope !== undefined) {
    const pi = scope.privProps.size ? scope.privProps.get(name) : undefined;
    if (pi !== undefined && (obj.cls === scope || obj.cls.ancestors.has(scope.lname))) return pi;
  }
  return obj.cls.props.get(name);
}
export function propAccessible(info, scope) {
  if (info.vis === 'public') return true;
  if (!scope) return false;
  if (info.vis === 'private') return scope === info.cls;
  return scope.ancestors.has(info.cls.lname) || info.cls.ancestors.has(scope.lname);
}
function guardEnter(obj, kind, name) {
  if (!obj.guards) obj.guards = new Set();
  const k = kind + name;
  if (obj.guards.has(k)) return false;
  obj.guards.add(k);
  return true;
}
function guardLeave(obj, kind, name) { obj.guards.delete(kind + name); }
export function magicGet(obj, name) {
  const m = obj.cls.methods.get('__get');
  if (!m || !guardEnter(obj, 'g', name)) return undefined;
  try { return callFunction(m.fn, [name], obj, m.cls, obj.cls, null); } finally { guardLeave(obj, 'g', name); }
}

export function readProp(obj, name, f) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) {
      const r = magicGet(obj, name);
      if (r !== undefined) return r;
      throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
    }
    key = info.key;
  }
  const slot = obj.props.get(key);
  if (slot !== undefined) return slot instanceof Ref ? slot.v : slot;
  if (obj.cls.nativeGet) { const r = obj.cls.nativeGet(obj, name); if (r !== undefined) return r; }
  const r = magicGet(obj, name);
  if (r !== undefined) return r;
  if (info && info.type) throwError('Error', `Typed property ${info.cls.name}::$${name} must not be accessed before initialization`);
  if (obj.cls.sprops.has(name)) notice(`Accessing static property ${obj.cls.name}::$${name} as non static`);
  warn(`Undefined property: ${obj.cls.name}::$${name}`);
  return null;
}
export function readPropQuiet(obj, name, f, issetOnly) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) return magicIsset(obj, name, issetOnly);
    key = info.key;
  }
  const slot = obj.props.get(key);
  if (slot !== undefined) return slot instanceof Ref ? slot.v : slot;
  if (obj.cls.nativeGet) { const r = obj.cls.nativeGet(obj, name); if (r !== undefined) return r; }
  return magicIsset(obj, name, issetOnly);
}
export function magicIsset(obj, name, issetOnly) {
  const mi = obj.cls.methods.get('__isset');
  if (!mi || !guardEnter(obj, 'i', name)) return undefined;
  let ok;
  try { ok = toBool(callFunction(mi.fn, [name], obj, mi.cls, obj.cls, null)); } finally { guardLeave(obj, 'i', name); }
  if (!ok) return undefined;
  if (issetOnly) return true;
  const r = magicGet(obj, name);
  return r === undefined ? null : r;
}
export function writeProp(obj, name, v, f) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) {
      if (magicSet(obj, name, v)) return;
      if (info.readonly && info.vis !== 'private') throwError('Error', `Cannot modify ${info.vis} readonly property ${obj.cls.name}::$${name}`);
      throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
    }
    key = info.key;
    if (info.readonly) {
      if (obj.props.has(key)) throwError('Error', `Cannot modify readonly property ${obj.cls.name}::$${name}`);
      if (scope !== info.cls) throwError('Error', `Cannot initialize readonly property ${obj.cls.name}::$${name} from ${scope ? 'scope ' + scope.name : 'global scope'}`);
    }
    if (info.type !== null) v = coercePropType(info, v, obj.cls.name, name);
  } else if (!obj.props.has(name)) {
    if (magicSet(obj, name, v)) return;
    if (obj.cls.sprops.has(name)) notice(`Accessing static property ${obj.cls.name}::$${name} as non static`);
    if (obj.cls.isEnum) throwError('Error', `Cannot create dynamic property ${obj.cls.name}::$${name}`);
    if (obj.cls.noDynamic) throwError('Error', `Cannot create dynamic property ${obj.cls.name}::$${name}`);
  }
  const slot = obj.props.get(key);
  if (slot instanceof Ref) slot.v = v; else obj.props.set(key, v);
  if (slot instanceof PHPObject && slot !== v && slot.cls.hasDestructor) gcCheck(slot);
}
function magicSet(obj, name, v) {
  const m = obj.cls.methods.get('__set');
  if (!m || !guardEnter(obj, 's', name)) return false;
  try { callFunction(m.fn, [name, v], obj, m.cls, obj.cls, null); } finally { guardLeave(obj, 's', name); }
  return true;
}
function resolvePropKey(obj, name, f, forWrite) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  if (info === undefined) return [name, null];
  if (info.vis !== 'public' && !propAccessible(info, scope)) throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
  if (forWrite && info.readonly && obj.props.has(info.key)) throwError('Error', `Cannot modify readonly property ${obj.cls.name}::$${name}`);
  return [info.key, info];
}
export function bindProp(obj, name, ref, f) {
  const [key] = resolvePropKey(obj, name, f, true);
  obj.props.set(key, ref);
}
export function propRef(obj, name, f) {
  const [key, info] = resolvePropKey(obj, name, f, true);
  const slot = obj.props.get(key);
  if (slot instanceof Ref) return slot;
  if (slot === undefined && !info) {
    rt.lastRetRef = null;
    const r = magicGet(obj, name);
    const rr = rt.lastRetRef; rt.lastRetRef = null;
    if (r !== undefined) { if (rr !== null && rr !== NOREF) return rr; notice(`Indirect modification of overloaded property ${obj.cls.name}::$${name} has no effect`); return new Ref(r); }
  }
  const r = new Ref(slot === undefined ? null : slot);
  obj.props.set(key, r);
  return r;
}
export function propArr(obj, name, f) {
  const [key, info] = resolvePropKey(obj, name, f, false);
  let slot = obj.props.get(key);
  if (slot === undefined && !info) {
    rt.lastRetRef = null;
    const r = magicGet(obj, name);
    const rr = rt.lastRetRef; rt.lastRetRef = null;
    if (r !== undefined) {
      if (r instanceof PHPObject) return r;
      if (rr !== null && rr !== NOREF) return writableArrIn(rr);
      notice(`Indirect modification of overloaded property ${obj.cls.name}::$${name} has no effect`);
      return r instanceof PHPArray ? r.clone() : new PHPArray();
    }
  }
  const isRef = slot instanceof Ref;
  let v = isRef ? slot.v : slot;
  if (v instanceof PHPObject) return v;
  if (info && info.readonly && obj.props.has(key)) throwError('Error', `Cannot modify readonly property ${obj.cls.name}::$${name}`);
  if (v instanceof PHPArray) {
    if (v.cow || v.fe) { v = v.clone(); if (isRef) slot.v = v; else obj.props.set(key, v); }
    return v;
  }
  if (v === null || v === undefined) {
    if (info && info.type && v === undefined && !info.type.alts.includes('array') && !info.type.alts.includes('mixed') && !info.type.alts.includes('iterable')) throwError('Error', `Typed property ${obj.cls.name}::$${name} must not be accessed before initialization`);
    const na = new PHPArray();
    if (isRef) slot.v = na; else obj.props.set(key, na);
    return na;
  }
  throwError('Error', 'Cannot use a scalar value as an array');
}
export function unsetProp(obj, name, f) {
  const scope = f ? f.cls : null;
  const info = propInfoFor(obj, name, scope);
  let key = name;
  if (info !== undefined) {
    if (info.vis !== 'public' && !propAccessible(info, scope)) {
      const m = obj.cls.methods.get('__unset');
      if (m) { callFunction(m.fn, [name], obj, m.cls, obj.cls, null); return; }
      throwError('Error', `Cannot access ${info.vis} property ${obj.cls.name}::$${name}`);
    }
    if (info.readonly) throwError('Error', `Cannot unset readonly property ${obj.cls.name}::$${name}`);
    key = info.key;
  }
  if (obj.props.has(key)) { const old = obj.props.get(key); obj.props.delete(key); gcCheck(old instanceof Ref ? old.v : old); return; }
  const m = obj.cls.methods.get('__unset');
  if (m && guardEnter(obj, 'u', name)) { try { callFunction(m.fn, [name], obj, m.cls, obj.cls, null); } finally { guardLeave(obj, 'u', name); } }
}

export function cloneObject(o, f) {
  if (!(o instanceof PHPObject)) throwError('Error', '__clone method called on non-object');
  if (o.cls.isEnum) throwError('Error', `Trying to clone an uncloneable object of class ${o.cls.name}`);
  if (o.cls === generatorClass) throwError('Error', 'Trying to clone an uncloneable object of class Generator');
  const c = new PHPObject(o.cls);
  for (const [k, v] of o.props) c.props.set(k, cp(v instanceof Ref ? v.v : v));
  for (const key of ['fn', 'bound', 'thisObj', 'scope', 'sc', 'trace', 'native']) if (o[key] !== undefined) c[key] = o[key];
  if (o.cls.nativeClone) o.cls.nativeClone(o, c);
  const m = o.cls.methods.get('__clone');
  // internal classes (here: prelude classes) with a private __clone() can't be cloned at all
  if (m && m.vis === 'private' && m.cls.decl && m.cls.decl.file === PRELUDE_FILE) throwError('Error', `Trying to clone an uncloneable object of class ${o.cls.name}`);
  if (m) {
    if (m.vis !== 'public' && !canAccessMember(m, f ? f.cls : null)) throwError('Error', `Call to ${m.vis} ${o.cls.name}::__clone() from ${f && f.cls ? 'scope ' + f.cls.name : 'global scope'}`);
    c.cloning = true;
    try { callFunction(m.fn, [], c, m.cls, c.cls, null); } finally { c.cloning = false; }
  }
  if (o.cls.hasDestructor) trackDestructible(c);
  return c;
}

// visible props as [name, value] pairs for a given scope
export function objVisibleProps(obj, scope) {
  const out = [];
  for (const [k, s] of obj.props) {
    const v = s instanceof Ref ? s.v : s;
    if (obj.cls.hasInternal && isInternalSlot(obj.cls, k)) continue;
    if (k.charCodeAt(0) === 0) {
      const p = k.indexOf('\0', 1);
      const owner = k.slice(1, p), name = k.slice(p + 1);
      if (scope && scope.name === owner) out.push([name, v]);
      continue;
    }
    const info = obj.cls.props.get(k);
    if (info && info.vis !== 'public' && !propAccessible(info, scope)) continue;
    out.push([k, v]);
  }
  return out;
}

export function toArrayCast(v) {
  if (v instanceof PHPArray) return v;
  if (v === null || v === undefined) return new PHPArray();
  if (v instanceof PHPObject) {
    if (v.cls === closureClass) return PHPArray.from([v]);
    if (v.cls.nativeToArray) return v.cls.nativeToArray(v);
    const np = nipProps(v);
    if (np) return np;
    const a = new PHPArray();
    for (const [k, s] of objectProps(v)) {
      const val = s instanceof Ref ? s.v : s;
      const info = v.cls.props.get(k);
      let key = k;
      if (info && info.vis === 'protected') key = '\0*\0' + k;
      a.set(normKey(key), cp(val));
    }
    return a;
  }
  return PHPArray.from([v]);
}
export function toObjectCast(v) {
  if (v instanceof PHPObject) return v;
  const o = new PHPObject(rt.classes.get('stdclass'));
  if (v instanceof PHPArray) { for (const [k, x] of v.entries()) o.props.set(String(k), cp(x)); }
  else if (v !== null && v !== undefined) o.props.set('scalar', v);
  return o;
}
