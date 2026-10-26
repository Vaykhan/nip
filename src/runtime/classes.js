// Classes and objects: declaration, inheritance, traits, enums, property and method access.

import { cp, FatalSig, isInt, NOREF, normKey, PHPArray, PHPObject, Ref, ThrowSig } from '../values.js';
import { toBool, toStr, typeOf, valueName } from '../convert.js';
import { isNum, looseEq, strictEq } from '../compare.js';
import { Frame, writableArrIn } from '../compiler/common.js';
import { cExpr } from '../compiler/expr.js';
import { rt } from './state.js';
import { deprecated, initThrowable, notice, PRELUDE_FILE, throwError, warn } from './errors.js';
import { callFunction, coercePropType, coerceType, compileFunction, FAIL, typeStr } from './functions.js';
import { callValue } from './callables.js';
import { dropRef, gcCheck, gcCollect } from './gc.js';
import { closureClass, generatorClass } from './native-classes.js';
import { lazyClass, lazyClassSrc } from './boot.js';
import { checkDelayed, checkInheritance } from './inheritance.js';

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

// whether an attribute list has the attribute (a lowercase, fully qualified name without leading \)
export function hasAttr(attrs, lname) { return !!attrs && attrs.some((a) => (a.name[0] === '\\' ? a.name.slice(1) : a.name).toLowerCase() === lname); }
// kind: 'Interface' or 'Trait' for the error message (a missing trait is a fatal error)
export function lookupClass(name, quiet, kind) {
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
  if (kind === 'Trait') throw new FatalSig(`Trait "${n}" not found`, rt.line, rt.file);
  throwError('Error', `${kind || 'Class'} "${n}" not found`);
}
// class lookup for inheritance checks: no autoloading until the class is registered
const resolveForCheck = (n) => classExists(n, false);
const autoloadForCheck = (n) => classExists(n, true);
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
  cls.abstract = decl.flags.abstract; cls.final = decl.flags.final || decl.kind === 'enum'; cls.readonly = decl.flags.readonly;
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
    // interfaces (an enum implements UnitEnum, and BackedEnum if backed, after the ones it lists)
    const ifaces = decl.interfaces.map((iname) => lookupClass(iname, false, 'Interface'));
    if (cls.isEnum) { ifaces.push(rt.classes.get('unitenum')); if (decl.enumType) ifaces.push(rt.classes.get('backedenum')); }
    const what = cls.isEnum ? 'Enum' : cls.isInterface ? 'Interface' : 'Class';
    ifaces.forEach((ic, i) => {
      if (!ic.isInterface) throw new FatalSig(`${cls.name} cannot implement ${ic.name} - it is not an interface`, decl.l, decl.file);
      if (ifaces.indexOf(ic) < i) throw new FatalSig(`${what} ${cls.name} cannot implement previously implemented interface ${ic.name}`, decl.l, decl.file);
      // a constant inherited from two places, and not redeclared, is ambiguous
      for (const [k, v] of ic.consts) {
        const ex = cls.consts.get(k);
        if (ex && ex.cls !== v.cls && !decl.consts.some((c) => c.name === k)) {
          if (v.final && ex.cls !== v.cls) throw new FatalSig(`${ex.cls.name}::${k} cannot override final constant ${v.cls.name}::${k}`, decl.l, decl.file);
          throw new FatalSig(`${what} ${cls.name} inherits both ${ex.cls.name}::${k} and ${v.cls.name}::${k}, which is ambiguous`, decl.l, decl.file);
        }
      }
      addInterface(cls, ic);
    });
    if (!cls.isInterface) checkSpecialInterfaces(cls, decl, what);
    // constants
    for (const c of decl.consts) {
      const ex = cls.consts.get(c.name);
      if (ex && ex.final && ex.cls !== cls) throw new FatalSig(`${cls.name}::${c.name} cannot override final constant ${ex.cls.name}::${c.name}`, decl.l, decl.file);
      cls.consts.set(c.name, { E: cExpr(c.e), val: undefined, done: false, cls, vis: c.vis, final: c.final, decl: c });
    }
    // traits (their defaults may use the class's constants)
    if (decl.traits.length) bindTraits(cls, decl);
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
    if (cls.methods.has('__tostring')) cls.ancestors.add('stringable');
    checkInheritance(cls, decl, resolveForCheck);
    // abstract check
    // zend_verify_abstract_class: an abstract class still has to implement private abstract methods
    if (!cls.isInterface && !cls.isTrait) {
      const abs = [...cls.methods.values()].filter((m) => m.abstract && (!cls.abstract || m.vis === 'private'));
      if (abs.length) {
        const n = abs.length, s = n > 1 ? 's' : '';
        const list = abs.slice(0, 3).map((m) => m.cls.name + '::' + m.name).join(', ') + (n > 3 ? ', ...' : '');
        const what = cls.isEnum ? 'Enum' : 'Class';
        throw new FatalSig(!cls.abstract && !cls.isEnum
          ? `${what} ${cls.name} contains ${n} abstract method${s} and must therefore be declared abstract or implement the remaining methods (${list})`
          : `${what} ${cls.name} must implement ${n} abstract private method${s} (${list})`, decl.l, decl.file);
      }
    }
    if (cls.parent || decl.traits.length) {
      const own = new Map(), rest = [];
      for (const [k, m] of cls.methods) { if (m.cls === cls) own.set(k, m); else rest.push([k, m]); }
      for (const [k, m] of rest) own.set(k, m);
      cls.methods = own;
    }
    cls.allowDynamic = (!!cls.parent && cls.parent.allowDynamic) || hasAttr(decl.attrs, 'allowdynamicproperties'); // inherited
    cls.noDynamic = cls.readonly;
    for (const m of cls.methods.values()) {
      // an abstract method of a used trait counts as the overridden method
      const fromTrait = () => decl.traits.some((tu) => tu.names.some((tn) => { const t = lookupClass(tn, true); const tm = t && t.methods.get(m.name.toLowerCase()); return !!tm && tm.abstract; }));
      if (m.cls === cls && !cls.isTrait && m.fn.decl && hasAttr(m.fn.decl.attrs, 'override') && !m.proto && !fromTrait()) {
        throw new FatalSig(`${displayName(cls)}::${m.name}() has #[\\Override] attribute, but no matching parent method exists`, m.fn.decl.l, decl.file);
      }
    }
    cls.hasDestructor = cls.methods.has('__destruct');
    cls.nipHooks = cls.methods.has('__nipget');
    if (!decl.anon) { rt.classes.set(lname, cls); decl.declared = true; }
    checkDelayed(cls, autoloadForCheck);
  } finally { rt.line = savedLine; rt.file = savedFile; }
  return cls;
}

// interfaces only some classes may implement (their interface_gets_implemented handlers)
function checkSpecialInterfaces(cls, decl, what) {
  const at = (msg, l = decl.l, file = decl.file) => new FatalSig(msg, l, file);
  const anc = cls.ancestors;
  if (anc.has('throwable')) {
    let root = cls;
    while (root.parent) root = root.parent;
    if (root.lname !== 'exception' && root.lname !== 'error') throw at(cls.isEnum ? `${what} ${cls.name} cannot implement interface Throwable` : `${what} ${cls.name} cannot implement interface Throwable, extend Exception or Error instead`);
  }
  if (!cls.isEnum && anc.has('unitenum')) throw at(`Non-enum class ${cls.name} cannot implement interface ${anc.has('backedenum') && !decl.interfaces.some((n) => /^\\?unitenum$/i.test(n)) ? 'BackedEnum' : 'UnitEnum'}`);
  if (cls.isEnum && !decl.enumType && anc.has('backedenum')) throw at(`Non-backed enum ${cls.name} cannot implement interface BackedEnum`);
  if (anc.has('iterator') && anc.has('iteratoraggregate')) throw at(`${what} ${cls.name} cannot implement both Iterator and IteratorAggregate at the same time`);
  if (anc.has('traversable') && !anc.has('iterator') && !anc.has('iteratoraggregate') && !cls.abstract && decl.file !== PRELUDE_FILE) {
    throw at(`${what} ${cls.name} must implement interface Traversable as part of either Iterator or IteratorAggregate`, 0, 'Unknown');
  }
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
  if (m.abstract && ex && !ex.abstract) {
    if (!m.origin && ex.cls !== owner && ex.vis !== 'private' && decl.file !== PRELUDE_FILE) throw new FatalSig(`Cannot make non abstract method ${displayName(ex.cls)}::${ex.name}() abstract in class ${displayName(cls)}`, decl.l, decl.file);
    return; // keep concrete implementation (e.g. from trait/parent)
  }
  const fn = compileFunction(decl, { method: true, cls: owner });
  fn.name = name;
  if (lname === '__tostring' && !fn.ret) fn.ret = { alts: ['string'], nullable: false };
  const method = { name, fn, cls: owner, vis: m.vis, static: m.static, abstract: m.abstract || !decl.body, final: m.final, proto: ex && ex.vis !== 'private' && (lname !== '__construct' || ex.abstract) ? (ex.proto || ex.cls) : null };
  if (m.origin) method.origin = m.origin; // the trait the method was copied from
  if (decl.body === null && !cls.isInterface && !m.abstract) method.abstract = true;
  cls.methods.set(lname, method);
  if (m.vis === 'private') { if (!cls.privMethods) cls.privMethods = new Map(); cls.privMethods.set(lname, method); }
}
// trait composition (zend_do_bind_traits): the rules of all `use` blocks are checked, then
// methods, constants and properties are copied in trait order. Members the class declares itself
// win over trait members, and two traits may only bring the same method, constant or property if
// one of them is abstract or the definitions are identical.
function bindTraits(cls, decl) {
  const at = (msg) => new FatalSig(msg, decl.l, decl.file);
  const traits = [], rules = [];
  for (const tu of decl.traits) {
    for (const n of tu.names) {
      const t = lookupClass(n, false, 'Trait');
      if (!t.isTrait) throw at(`${cls.name} cannot use ${t.name} - it is not a trait`);
      traits.push(t);
    }
    rules.push(...tu.rules);
  }
  const usedTrait = (name) => {
    const t = lookupClass(name, true);
    if (!t) throw at(`Could not find trait ${name}`);
    if (!t.isTrait) throw at(`Class ${t.name} is not a trait, Only traits may be used in 'as' and 'insteadof' statements`);
    if (!traits.includes(t)) throw at(`Required Trait ${t.name} wasn't added to ${cls.name}`);
    return t;
  };
  const excluded = new Map(); // trait -> Set of excluded method lnames
  const aliases = []; // [rule, trait]
  for (const r of rules) {
    const ln = r.method.toLowerCase();
    if (r.kind === 'insteadof') {
      const t = usedTrait(r.trait);
      if (!t.methods.has(ln)) throw at(`A precedence rule was defined for ${t.name}::${r.method} but this method does not exist`);
      for (const en of r.excl) {
        const et = usedTrait(en);
        let set = excluded.get(et);
        if (!set) excluded.set(et, set = new Set());
        if (set.has(ln)) throw at(`Failed to evaluate a trait precedence (${r.method}). Method of trait ${et.name} was defined to be excluded multiple times`);
        set.add(ln);
        if (et === t) throw at(`Inconsistent insteadof definition. The method ${r.method} is to be used from ${t.name}, but ${t.name} is also on the exclude list`);
      }
      continue;
    }
    let t = null;
    if (r.trait) {
      t = usedTrait(r.trait);
      if (!t.methods.has(ln)) throw at(`An alias was defined for ${t.name}::${r.method} but this method does not exist`);
    } else {
      for (const ut of traits) {
        if (!ut.methods.has(ln)) continue;
        if (t && t !== ut) throw at(`An alias was defined for method ${r.method}(), which exists in both ${t.name} and ${ut.name}. Use ${t.name}::${r.method} or ${ut.name}::${r.method} to resolve the ambiguity`);
        t = ut;
      }
      if (!t) throw at(r.alias ? `An alias (${r.alias}) was defined for method ${r.method}(), but this method does not exist` : `The modifiers of the trait method ${r.method}() are changed, but this method does not exist. Error`);
    }
    aliases.push([r, t]);
  }
  // methods
  const own = new Set(decl.methods.map((m) => m.fn.name.toLowerCase()));
  const fromTrait = new Map(); // lname -> { t, m, name } added from a trait
  const addTraitMethod = (t, m, name, vis, final) => {
    const ln = name.toLowerCase();
    const prev = fromTrait.get(ln);
    if (prev && prev.m.fn.decl === m.fn.decl && prev.vis === vis) return;
    if (m.abstract && (own.has(ln) || prev || cls.methods.has(ln))) {
      if (own.has(ln) || prev) (cls.traitAbstracts || (cls.traitAbstracts = [])).push(m);
      return; // the existing method must satisfy the abstract signature
    }
    if (own.has(ln)) return;
    if (prev && !prev.m.abstract) throw at(`Trait method ${t.name}::${m.name} has not been applied as ${cls.name}::${name}, because of collision with ${prev.t.name}::${prev.name}`);
    if (prev) (cls.traitAbstracts || (cls.traitAbstracts = [])).push(prev.m); // the method must satisfy the abstract one it replaces
    fromTrait.set(ln, { t, m, name, vis });
    addMethod(cls, m.fn.decl, { vis, static: m.static, abstract: m.abstract, final, origin: m.origin || t }, cls, name === m.name ? undefined : name);
  };
  for (const t of traits) {
    const ex = excluded.get(t);
    for (const [ln, m] of t.methods) {
      for (const [r, at2] of aliases) {
        if (r.alias && at2 === t && r.method.toLowerCase() === ln) addTraitMethod(t, m, r.alias, r.vis || m.vis, m.final || !!r.final);
      }
      if (ex && ex.has(ln)) continue;
      let vis = m.vis, final = m.final;
      for (const [r, at2] of aliases) if (!r.alias && at2 === t && r.method.toLowerCase() === ln) { if (r.vis) vis = r.vis; if (r.final) final = true; }
      addTraitMethod(t, m, m.name, vis, final);
    }
    for (const a of t.traitIfaces || []) cls.ancestors.add(a);
  }
  // constants
  const constOwner = new Map(); // name -> trait that brought it
  const ownConsts = new Map(decl.consts.map((c) => [c.name, c]));
  traits.forEach((t, i) => {
    for (const [k, c] of t.consts) {
      const ownC = ownConsts.get(k);
      const ex = ownC ? { E: cExpr(ownC.e), vis: ownC.vis, final: !!ownC.final, type: ownC.type, cls } : cls.consts.get(k);
      if (!ex) { cls.consts.set(k, { E: c.E, val: undefined, done: false, cls, vis: c.vis, final: c.final, decl: c.decl }); constOwner.set(k, t); continue; }
      const exCls = ownC || constOwner.has(k) ? cls : ex.cls;
      const first = exCls === cls ? (traits.slice(0, i).find((pt) => pt.consts.has(k)) || cls) : exCls;
      const same = ex.vis === c.vis && !!ex.final === !!c.final && sameType(constType(ex), constType(c)) && sameValue(() => (ex.E ? ex.E(constFrame(cls)) : ex.val), () => c.E(constFrame(cls)));
      if (!same) throw at(`${first.name} and ${t.name} define the same constant (${k}) in the composition of ${cls.name}. However, the definition differs and is considered incompatible. Class was composed`);
    }
  });
  // properties
  const ownProps = new Map(decl.props.map((p) => [p.name, p]));
  const ctor = decl.methods.find((m) => m.fn.name.toLowerCase() === '__construct');
  if (ctor) for (const prm of ctor.fn.params) if (prm.promote) ownProps.set(prm.name, { name: prm.name, vis: prm.promote, type: prm.type, readonly: prm.readonly, static: false, hasDef: false });
  const propOwner = new Map(); // name -> trait that brought it
  traits.forEach((t, i) => {
    const tprops = [...[...t.slots.values()].map((info) => info.decl), ...[...t.sprops.values()].map((si) => si.decl)].filter(Boolean);
    for (const pd of tprops) {
      const name = pd.name, tStatic = !!pd.static;
      const ownP = ownProps.get(name);
      let ex = ownP, exCls = cls;
      if (!ex && propOwner.has(name)) ex = propOwner.get(name).decl;
      if (!ex) {
        const inh = tStatic ? cls.sprops.get(name) : cls.props.get(name);
        if (inh && !(inh.vis === 'private' && inh.cls !== cls)) { ex = inh.decl || inh; exCls = inh.cls; }
      }
      if (ex) {
        const first = exCls === cls ? (traits.slice(0, i).find((pt) => hasTraitProp(pt, name)) || cls) : exCls;
        const same = (ex.vis || 'public') === (pd.vis || 'public') && !!ex.static === tStatic && !!ex.readonly === !!pd.readonly &&
          sameType(ex.type, pd.type) && sameValue(() => declaredDefault(ex, exCls), () => declaredDefault(pd, cls));
        if (!same) throw at(`${first.name} and ${t.name} define the same property ($${name}) in the composition of ${cls.name}. However, the definition differs and is considered incompatible. Class was composed`);
        if (ownP || !tStatic) continue;
      }
      if (cls.readonly && !pd.readonly) throw at(`Readonly class ${cls.name} cannot use trait with a non-readonly property ${t.name}::$${name}`);
      const info = tStatic ? t.sprops.get(name) : [...t.slots.values()].find((x) => x.decl === pd);
      addProp(cls, Object.assign({}, pd, { defE: info && info.defE }), cls);
      propOwner.set(name, { t, decl: pd });
    }
  });
}
const constType = (c) => c.type || (c.decl && c.decl.type) || null;
function hasTraitProp(t, name) { return t.sprops.has(name) || [...t.slots.values()].some((x) => x.decl && x.decl.name === name); }
// a property's default value as declared (undefined: none, for typed properties)
function declaredDefault(p, owner) {
  if (p.hasDef) return (p.defE || cExpr(p.def))(constFrame(owner));
  return p.type ? undefined : null;
}
function sameType(a, b) {
  if (!a || !b) return !a && !b;
  return typeStr(a, null, true) === typeStr(b, null, true);
}
function sameValue(fa, fb) {
  const a = fa(), b = fb();
  if (a === undefined || b === undefined) return a === b;
  return strictEq(a, b);
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

// direct: a fetch written in code (Foo::BAR, constant()), which can't name a trait
export function classConst(cls, name, f, direct) {
  const c = cls.consts.get(name);
  if (c === undefined) throwError('Error', `Undefined constant ${cls.name}::${name}`);
  if (c.vis === 'private' && f && f.cls !== c.cls) throwError('Error', `Cannot access private constant ${cls.name}::${name}`);
  if (direct && cls.isTrait) throwError('Error', `Cannot access trait constant ${cls.name}::${name} directly`);
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
    if (c.val !== null && typeof c.val === 'object') rt.constRoots.push(c.val); // enum cases, new in constants
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
  if (cls.isTrait && cls.decl && cls.decl.file !== PRELUDE_FILE) deprecated(`Accessing static trait property ${cls.name}::$${name} is deprecated, it should only be accessed on a class using the trait`);
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
  } else if (obj.cls.sprops.size && obj.cls.sprops.has(name)) notice(`Accessing static property ${obj.cls.name}::$${name} as non static`);
  const slot = obj.props.get(key);
  if (slot !== undefined) return slot instanceof Ref ? slot.v : slot;
  if (obj.cls.nipHooks && info === undefined) { const r = nipHook(obj, '__nipget', [name]); if (r !== undefined) return r; }
  const r = magicGet(obj, name);
  if (r !== undefined) return r;
  if (info && info.type) throwError('Error', `Typed property ${info.cls.name}::$${name} must not be accessed before initialization`);
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
  if (obj.cls.nipHooks && info === undefined) { const r = nipHook(obj, '__nipisset', [name]); if (r !== undefined) return r === null ? undefined : r; }
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
    if (obj.cls.nipHooks && nipHook(obj, '__nipset', [name, v]) !== undefined) return;
    if (magicSet(obj, name, v)) return;
    if (obj.cls.sprops.has(name)) notice(`Accessing static property ${obj.cls.name}::$${name} as non static`);
    newDynamicProp(obj, name);
  } else if (obj.cls.sprops.size && obj.cls.sprops.has(name)) notice(`Accessing static property ${obj.cls.name}::$${name} as non static`);
  const slot = obj.props.get(key);
  if (slot instanceof Ref) slot.v = v; else obj.props.set(key, v);
  if (slot !== v && slot !== null && typeof slot === 'object' && !(slot instanceof Ref)) { dropRef(slot); if (slot instanceof PHPObject && slot.cls.hasDestructor) gcCheck(slot); }
}
// Prelude classes can handle accesses to undefined properties before the magic methods do
// (ArrayObject::ARRAY_AS_PROPS): __nipGet/__nipIsset/__nipSet/__nipUnset return [true, value]
// when they handled the access.
function nipHook(obj, mname, args) {
  const m = obj.cls.methods.get(mname);
  const r = callFunction(m.fn, args, obj, m.cls, obj.cls, null);
  return r instanceof PHPArray && r.get(0) === true ? r.get(1) : undefined;
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
  const [key, info] = resolvePropKey(obj, name, f, true);
  if (!info && !obj.props.has(key)) newDynamicProp(obj, name);
  obj.props.set(key, ref);
}
// PHP 8.2: creating an undeclared property is deprecated unless the class (or a parent) has
// #[AllowDynamicProperties]; readonly classes and enums don't allow it at all
function newDynamicProp(obj, name) {
  const c = obj.cls;
  if (c.isEnum || c.noDynamic) throwError('Error', `Cannot create dynamic property ${c.name}::$${name}`);
  if (!c.allowDynamic && rt.file !== PRELUDE_FILE) deprecated(`Creation of dynamic property ${c.anon ? displayName(c) : c.name}::$${name} is deprecated`);
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
  if (slot === undefined && !info) newDynamicProp(obj, name);
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
    if (slot === undefined && !info) newDynamicProp(obj, name);
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
  if (obj.props.has(key)) { const old = obj.props.get(key); obj.props.delete(key); dropRef(old instanceof Ref ? old.v : old); gcCheck(old instanceof Ref ? old.v : old); return; }
  if (obj.cls.nipHooks && info === undefined && nipHook(obj, '__nipunset', [name]) !== undefined) return;
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
