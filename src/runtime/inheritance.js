// Method compatibility rules PHP enforces when a class is linked (zend_inheritance.c):
// static/abstract/visibility changes and signature compatibility (Liskov substitution:
// contravariant parameters, covariant return types).
import { FatalSig, PHPArray } from '../values.js';
import { toStr } from '../convert.js';
import { Frame } from '../compiler/common.js';
import { cExpr } from '../compiler/expr.js';
import { rt } from './state.js';
import { deprecated, PRELUDE_FILE } from './errors.js';
import { typeStr } from './functions.js';
import { CLASS_ARGINFO } from './arginfo.js';

// thrown while hoisting when a type names a class that isn't declared yet: PHP then declares
// the class at runtime instead of at compile time
export const UNRESOLVED = { unresolved: true };

const VIS_RANK = { public: 0, protected: 1, private: 2 };
const lcName = (s) => s.toLowerCase();
const inhClsName = (c) => { const i = c.name.indexOf('\0'); return i < 0 ? c.name : c.name.slice(0, i); };

// --- type algebra: a type is { any, void, builtins: Set, classes: [[name, ...], ...] } where
// each entry of classes is an intersection (a single class is a one-element intersection)
function normType(t, scope) {
  const r = { any: false, builtins: new Set(), classes: [] };
  if (t.nullable) r.builtins.add('null');
  for (const a of t.alts) {
    if (typeof a === 'object') { r.classes.push(a.inter.map((n) => resolveSelf(n, scope))); continue; }
    switch (lcName(a)) {
      case 'mixed': r.any = true; break;
      case 'bool': r.builtins.add('true'); r.builtins.add('false'); break;
      case 'iterable': r.builtins.add('array'); r.classes.push(['Traversable']); break;
      case 'int': case 'float': case 'string': case 'true': case 'false': case 'array': case 'object':
      case 'callable': case 'null': case 'void': case 'never': case 'static':
        r.builtins.add(lcName(a)); break;
      default: r.classes.push([resolveSelf(a, scope)]);
    }
  }
  return r;
}
function resolveSelf(n, scope) {
  const l = lcName(n);
  if (l === 'self' && scope && !scope.isTrait) return scope.name;
  if (l === 'parent' && scope && scope.parent) return scope.parent.name;
  return n;
}

// is class `a` a subtype of class `b`? Returns true, false, or the name of a missing class
function classSub(a, b, ctx) {
  if (lcName(a) === lcName(b)) return true;
  const ca = ctx.resolve(a);
  if (!ca) return a;
  const cb = ctx.resolve(b);
  if (cb) return ca === cb || ca.ancestors.has(cb.lname);
  return ca.ancestors.has(lcName(b)) || b;
}
// is intersection `fe` a subtype of intersection `proto`? (every proto member is implemented
// by some fe member)
function interSub(fe, proto, ctx) {
  let missing = null;
  for (const p of proto) {
    let ok = false;
    for (const c of fe) { const r = classSub(c, p, ctx); if (r === true) { ok = true; break; } if (r !== false && !missing) missing = r; }
    if (!ok) return missing || false;
  }
  return true;
}
// does `t` (resolved in `scope`) accept instances of class `self`?
function permitsSelf(t, self, ctx) {
  if (t.builtins.has('object')) return true;
  return t.classes.some((inter) => interSub([self.name], inter, ctx) === true);
}
// covariant check: is `fe` a subtype of `proto`? Returns true, false or a missing class name.
function typeSub(fe, feScope, proto, protoScope, ctx) {
  if (proto.any && !fe.builtins.has('void')) return true;
  if (fe.any) return false;
  let missing = null;
  for (const b of fe.builtins) {
    if (proto.builtins.has(b) || b === 'never') continue;
    if (b === 'static' && feScope && permitsSelf(proto, feScope, ctx)) continue;
    return false;
  }
  for (const inter of fe.classes) {
    if (proto.builtins.has('object')) continue;
    let ok = false;
    for (const p of proto.classes) {
      const r = interSub(inter, p, ctx);
      if (r === true) { ok = true; break; }
      if (r !== false && !missing) missing = r;
    }
    if (!ok) return missing || false;
  }
  return true;
}

// --- signatures as PHP prints them in error messages (zend_get_function_declaration)
function foldable(n) {
  switch (n.k) {
    case 'Lit': return true;
    case 'Const': return ['true', 'false', 'null'].includes(lcName(n.name));
    case 'ClassName': return typeof n.cls === 'string' && !['self', 'static', 'parent'].includes(lcName(n.cls));
    case 'Arr': return n.items.every((it) => it && !it.spread && !it.byRef && (!it.key || foldable(it.key)) && foldable(it.v));
    case 'Neg': case 'Plus': case 'BitNot': case 'Not': return foldable(n.e);
    case 'Bin': return foldable(n.a) && foldable(n.b);
    case 'Ternary': return foldable(n.c) && (!n.a || foldable(n.a)) && foldable(n.b);
  }
  return false;
}
function defaultStr(n, scope) {
  if (n.k === 'Const' && !foldable(n)) return n.name.replace(/^\\/, '');
  // self::class is resolved when the class is compiled (not in traits)
  if (n.k === 'ClassName' && n.cls === 'self' && scope && !scope.isTrait) return `'${scope.name.length > 10 ? scope.name.slice(0, 10) + '...' : scope.name}'`;
  if (n.k === 'CConst' && typeof n.cls === 'string') return `${n.cls.replace(/^\\/, '')}::${n.name}`;
  if (!foldable(n)) return '<expression>';
  let v;
  try { v = cExpr(n)(new Frame(null, null, null, null)); } catch (e) { return '<expression>'; }
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'string') return `'${v.length > 10 ? v.slice(0, 10) + '...' : v}'`;
  if (v instanceof PHPArray) return v.size ? '[...]' : '[]';
  return toStr(v);
}
// A method's signature in one shape for user methods and internal ones (from arginfo):
// { owner, name, byRef, params: [{ type, name, byRef, variadic, optional, def }], ret, tentative }
// where def is the default value as PHP prints it.
// `scope` resolves self (in a trait: the class using it); types print as declared in traits
// owner: the class the method is named after in messages
function userSig(m, scope = m.cls, owner = m.cls) {
  const fn = m.fn;
  let required = 0;
  fn.params.forEach((p, i) => { if (!p.defNode && !p.variadic) required = i + 1; });
  return {
    owner: inhClsName(owner), name: m.name, byRef: !!fn.decl.byRef, scope, printScope: m.origin || m.cls.isTrait ? null : m.cls, ret: fn.ret || null, tentative: false,
    params: fn.params.map((p, i) => ({ type: p.type, name: p.name, byRef: !!p.byRef, variadic: !!p.variadic, optional: i >= required, def: p.defNode && !p.variadic ? defaultStr(p.defNode, m.cls) : null })),
  };
}
function parseTypeStr(str) {
  let nullable = false;
  if (str[0] === '?') { nullable = true; str = str.slice(1); }
  const alts = [];
  for (let a of str.split('|')) {
    a = a.replace(/^\(|\)$/g, '');
    if (a.includes('&')) alts.push({ inter: a.split('&') });
    else if (a === 'null') nullable = true;
    else alts.push(a);
  }
  return { alts, nullable };
}
// PHP's signature of internal method `lname`, as declared by the nearest class from `start`
// upwards (the parent chain, or an interface's own declaration)
function internalSig(lname, start, scope) {
  for (let c = start; c; c = c.parent) {
    const info = CLASS_ARGINFO[c.lname], a = info && info[1][lname];
    if (!a) continue;
    const [name, ret, tentative, byRef, params] = a;
    return {
      owner: info[0], name, byRef: !!byRef, scope, printScope: null, ret: ret ? parseTypeStr(ret) : null, tentative: !!tentative,
      params: params.map(([t, n, fl, def]) => ({ type: t ? parseTypeStr(t) : null, name: n, byRef: !!(fl & 1), variadic: !!(fl & 2), optional: !!(fl & 4), def: fl & 2 ? null : def })),
    };
  }
  return null;
}
// PHP's signature of a method of an internal class (for Reflection), or null
export function internalMethodSig(cls, lname) { return internalSig(lname, cls, cls); }
function sigStr(sg) {
  const scope = sg.printScope;
  let s = (sg.byRef ? '& ' : '') + sg.owner + '::' + sg.name + '(';
  s += sg.params.map((p) => (p.type ? typeStr(p.type, scope) + ' ' : '') + (p.byRef ? '&' : '') + (p.variadic ? '...' : '') + '$' + p.name + (p.def !== null ? ' = ' + p.def : '')).join(', ') + ')';
  if (sg.ret) s += ': ' + typeStr(sg.ret, scope);
  return s;
}

function requiredArgs(sg) {
  let n = 0;
  sg.params.forEach((p, i) => { if (!p.optional && !p.variadic) n = i + 1; });
  return n;
}
// zend_do_perform_implementation_check: true, false, 'warning' (tentative return type) or a
// missing class name
function compatible(fe, pr, ctx) {
  if (requiredArgs(pr) < requiredArgs(fe)) return false;
  if (pr.byRef && !fe.byRef) return false;
  const pv = pr.params.length && pr.params[pr.params.length - 1].variadic, fv = fe.params.length && fe.params[fe.params.length - 1].variadic;
  if (pv && !fv) return false;
  const n = Math.max(pr.params.length, fe.params.length);
  let status = true;
  for (let i = 0; i < n; i++) {
    const pa = i < pr.params.length ? pr.params[i] : pv ? pr.params[pr.params.length - 1] : null;
    const fa = i < fe.params.length ? fe.params[i] : fv ? fe.params[fe.params.length - 1] : null;
    if (!pa) continue;
    if (!fa) return false;
    if (fa.type && !fa.type.alts.some((a) => a === 'mixed')) {
      if (!pa.type) return false;
      const r = typeSub(normType(pa.type, pr.scope), pr.scope, normType(fa.type, fe.scope), fe.scope, ctx);
      if (r === false) return false;
      if (r !== true && status === true) status = r;
    }
    if (fa.byRef !== pa.byRef) return false;
  }
  if (pr.ret) {
    if (!fe.ret) return pr.tentative ? (status === true ? 'warning' : status) : false;
    const r = typeSub(normType(fe.ret, fe.scope), fe.scope, normType(pr.ret, pr.scope), pr.scope, ctx);
    if (r === false) return pr.tentative ? 'warning' : false;
    if (r !== true) return r;
  }
  return status;
}

// PHP's method table order of class `c`: its own methods, then the inherited ones
function methodTableOrder(c) {
  const info = CLASS_ARGINFO[c.lname];
  const own = info ? Object.keys(info[1]) : [...c.methods.values()].filter((m) => m.cls === c).map((m) => m.name.toLowerCase());
  const seen = new Set(own);
  if (c.parent) for (const k of methodTableOrder(c.parent)) if (!seen.has(k)) { seen.add(k); own.push(k); }
  return own;
}
const ownPropNames = (c) => {
  if (!c.decl) return [...c.props.keys(), ...c.sprops.keys()];
  const ctor = c.decl.methods.find((m) => m.fn.name.toLowerCase() === '__construct');
  return c.decl.props.map((p) => p.name).concat(ctor ? ctor.fn.params.filter((p) => p.promote).map((p) => p.name) : []);
};
function propTableOrder(c) {
  const names = [], seen = new Set();
  for (; c; c = c.parent) for (const n of ownPropNames(c)) if (!seen.has(n)) { seen.add(n); names.push(n); }
  return names;
}
// do_inherit_property: redeclared properties keep static-ness, readonly-ness, visibility (or
// widen it) and the exact type
function checkProps(cls, decl, resolve) {
  const own = new Set(ownPropNames(cls));
  const P = cls.parent, at = (msg) => new FatalSig(msg, decl.l, decl.file);
  const ctx = { resolve: (n) => (lcName(n) === cls.lname ? cls : resolve(n)) };
  for (const n of propTableOrder(P)) {
    if (!own.has(n)) continue;
    const pi = P.sprops.get(n) || P.props.get(n);
    if (!pi || pi.vis === 'private') continue;
    const pStatic = P.sprops.has(n) && P.sprops.get(n) === pi;
    const cStatic = !!cls.sprops.get(n) && cls.sprops.get(n).cls === cls;
    const ci = cStatic ? cls.sprops.get(n) : cls.props.get(n);
    if (!ci || ci.cls !== cls) continue;
    const pn = `${inhClsName(pi.cls)}::$${n}`, cn = `${inhClsName(cls)}::$${n}`;
    if (pStatic !== cStatic) throw at(`Cannot redeclare ${pStatic ? '' : 'non '}static ${pn} as ${cStatic ? '' : 'non '}static ${cn}`);
    if (!!pi.readonly !== !!ci.readonly) throw at(`Cannot redeclare ${pi.readonly ? '' : 'non-'}readonly property ${pn} as ${ci.readonly ? '' : 'non-'}readonly ${cn}`);
    if (pi.final) throw at(`Cannot override final property ${pn}`);
    // set visibility (PHP 8.4): the same or weaker than the parent's (its visibility when it has none)
    if (ci.setVis && !(pi.hooks && pi.virtual && !pi.hooks.set) && VIS_RANK[ci.setVis] > VIS_RANK[pi.setVis || pi.vis]) throw at(`Set access level of ${cn} must be ${pi.setVis ? pi.setVis + '(set)' : 'omitted'} (as in class ${inhClsName(pi.cls)})${pi.setVis ? ' or weaker' : ''}`);
    if (VIS_RANK[ci.vis] > VIS_RANK[pi.vis]) throw at(`Access level to ${cn} must be ${pi.vis} (as in class ${inhClsName(pi.cls)})${pi.vis === 'protected' ? ' or weaker' : ''}`);
    const pt = pi.decl ? pi.decl.type : pi.type, ct = ci.decl ? ci.decl.type : ci.type;
    if (pt) {
      const a = ct && typeSub(normType(ct, cls), cls, normType(pt, pi.cls), pi.cls, ctx);
      const b = ct && typeSub(normType(pt, pi.cls), pi.cls, normType(ct, cls), cls, ctx);
      // (a virtual property's type only has to be covariant without set, contravariant without get)
      const getOnly = pi.virtual && pi.hooks && !pi.hooks.set, setOnly = pi.virtual && pi.hooks && !pi.hooks.get;
      if (ct && ((getOnly && a !== false) || (setOnly && b !== false))) continue;
      if (a === false || b === false || !ct) throw at(`Type of ${cn} must be ${typeStr(pt, null)} (as in class ${inhClsName(pi.cls)})`);
    } else if (ct) throw at(`Type of ${cn} must not be defined (as in class ${inhClsName(pi.cls)})`);
  }
}
// do_inherit_constant_check: visibility and (covariant) type of redeclared constants
function checkConsts(cls, decl, resolve) {
  const P = cls.parent, at = (msg) => new FatalSig(msg, decl.l, decl.file);
  const ctx = { resolve: (n) => (lcName(n) === cls.lname ? cls : resolve(n)) };
  // the parent's constants and the interfaces'
  const sources = (P ? [P] : []).concat(cls.ifaceList.filter((ic) => !P || !P.ifaceList.includes(ic)));
  for (const c of decl.consts) for (const S of sources) {
    const pc = S.consts.get(c.name);
    if (!pc || pc.case || pc.vis === 'private' || pc.cls === cls) continue;
    const vis = c.vis || 'public', pvis = pc.vis || 'public';
    const owner = pc.cls ? inhClsName(pc.cls) : inhClsName(S);
    if (VIS_RANK[vis] > VIS_RANK[pvis]) throw at(`Access level to ${inhClsName(cls)}::${c.name} must be ${pvis} (as in ${pc.cls && pc.cls.isInterface ? 'interface' : 'class'} ${owner})${pvis === 'protected' ? ' or weaker' : ''}`);
    const pt = pc.decl && pc.decl.type;
    if (pt && (!c.type || typeSub(normType(c.type, cls), cls, normType(pt, pc.cls), pc.cls, ctx) === false)) {
      throw at(`Type of ${inhClsName(cls)}::${c.name} must be compatible with ${owner}::${c.name} of type ${typeStr(pt, null)}`);
    }
  }
}

// All checks of a class being declared, in PHP's order: methods overriding the parent's, then
// abstract methods of used traits, then the interfaces' methods.
// property hooks (PHP 8.4): a set hook's parameter accepts the property's type; overriding hooks
// are checked like methods
function checkHooks(cls, decl, resolve) {
  const ctx = { resolve: (n) => (lcName(n) === cls.lname ? cls : resolve(n)) };
  for (const info of cls.props.values()) {
    if (info.cls !== cls || !info.hooks) continue;
    const set = info.hooks.set;
    if (set && set.cls === cls && set.decl.explicitParams && set.params[0]) {
      const pt = info.decl.type, at = set.params[0].type;
      if (pt && at && typeSub(normType(pt, cls), cls, normType(at, cls), cls, ctx) === false) {
        throw new FatalSig(`Type of parameter $${set.params[0].name} of hook ${cls.name}::$${info.name}::set must be compatible with property type`, info.decl.l, decl.file);
      }
    }
    const parent = cls.parent && cls.parent.props.get(info.name);
    if (parent && parent.hooks) {
      for (const kind of ['get', 'set']) {
        const ch = info.hooks[kind], ph = parent.hooks[kind];
        if (ch && ph && ch !== ph && ch.cls === cls) checkOverride(cls, asMethod(ch), asMethod(ph), resolve, 'parent');
      }
    }
  }
}
const asMethod = (fn) => ({ name: fn.name, fn, cls: fn.cls, vis: 'public', static: false, abstract: !!fn.abstractHook, final: false });
export function checkInheritance(cls, decl, resolve) {
  if (decl.file !== PRELUDE_FILE && rt.phpVersion >= 80400) checkHooks(cls, decl, resolve);
  if (cls.parent && decl.file !== PRELUDE_FILE) checkProps(cls, decl, resolve);
  if ((cls.parent || cls.ifaceList.length) && decl.file !== PRELUDE_FILE) checkConsts(cls, decl, resolve);
  if (cls.parent) {
    for (const k of methodTableOrder(cls.parent)) {
      const pm = cls.parent.methods.get(k), cm = cls.methods.get(k);
      if (pm && cm && cm !== pm) checkOverride(cls, cm, pm, resolve, 'parent');
    }
  }
  if (cls.traitAbstracts) {
    for (const am of cls.traitAbstracts) checkOverride(cls, cls.methods.get(am.name.toLowerCase()), am, resolve, 'trait');
    cls.traitAbstracts = null;
  }
  for (const iname of decl.interfaces) {
    const ic = resolve(iname);
    if (ic) for (const [k, im] of ic.methods) { const fm = cls.methods.get(k); if (fm && fm !== im) checkOverride(cls, fm, im, resolve, 'iface'); }
  }
}

// Check method `child` of class `cls` against the method it overrides or implements.
// resolve(name) returns a declared class or null. phase: 'parent' (overriding the parent's
// methods), 'trait' (a used trait's abstract method) or 'iface'. Methods a trait brought are
// named after the trait while traits are bound (parent and trait phases), else after the class.
function checkOverride(cls, child, proto, resolve, phase) {
  const fromTrait = phase === 'trait';
  if (!proto || proto === child || !proto.fn || !child.fn || child.fn.native || !child.fn.decl) return;
  if (child.fn.file === PRELUDE_FILE) return;
  const internal = proto.fn.native || proto.fn.file === PRELUDE_FILE;
  if (!internal && !proto.fn.decl) return;
  if (proto.vis === 'private' && !proto.abstract) return;
  const done = child.checked || (child.checked = new Set());
  if (done.has(proto)) return;
  done.add(proto);
  const at = (msg) => new FatalSig(msg, child.fn.line, child.fn.file);
  const psig = internal ? internalSig(proto.name.toLowerCase(), proto.cls.isInterface ? proto.cls : cls.parent, proto.cls) : userSig(proto, proto.cls.isTrait ? cls : proto.cls);
  if (!psig) return; // an internal method PHP doesn't have
  const parentName = psig.owner;
  const childOwner = phase !== 'iface' && child.origin ? child.origin : child.cls;
  if (!!child.static !== !!proto.static) {
    throw at(child.static ? `Cannot make non static method ${parentName}::${child.name}() static in class ${inhClsName(childOwner)}`
      : `Cannot make static method ${parentName}::${child.name}() non static in class ${inhClsName(childOwner)}`);
  }
  if (child.abstract && !proto.abstract) throw at(`Cannot make non abstract method ${parentName}::${child.name}() abstract in class ${inhClsName(childOwner)}`);
  // constructors are only checked against abstract or interface constructors
  if (lcName(proto.name) === '__construct' && !proto.abstract) return;
  // (abstract trait methods don't enforce visibility, for backwards compatibility)
  if (!fromTrait && VIS_RANK[child.vis] > VIS_RANK[proto.vis]) {
    throw at(`Access level to ${inhClsName(childOwner)}::${child.name}() must be ${proto.vis} (as in class ${parentName})${proto.vis === 'protected' ? ' or weaker' : ''}`);
  }
  const csig = userSig(child, child.cls, childOwner);
  const ctx = { resolve: (n) => (lcName(n) === cls.lname ? cls : resolve(n)) };
  const r = compatible(csig, psig, ctx);
  if (r !== true && r !== false && r !== 'warning') {
    // a class in the signatures isn't declared yet: at compile time, declare the class at
    // runtime instead; at runtime, check again once the class is registered and autoloading ran
    if (rt.hoisting) throw UNRESOLVED;
    (cls.delayedChecks || (cls.delayedChecks = [])).push({ child, csig, psig });
    return;
  }
  report(child, csig, psig, r);
}
function report(child, csig, psig, r) {
  if (r === true) return;
  const at = (msg) => new FatalSig(msg, child.fn.line, child.fn.file);
  if (r === 'warning') {
    const d = child.fn.decl;
    if (d.attrs && d.attrs.some((a) => lcName(a.name.replace(/^\\/, '')) === 'returntypewillchange')) return;
    const savedLine = rt.line, savedFile = rt.file;
    rt.line = child.fn.line; rt.file = child.fn.file;
    try { deprecated(`Return type of ${sigStr(csig)} should either be compatible with ${sigStr(psig)}, or the #[\\ReturnTypeWillChange] attribute should be used to temporarily suppress the notice`); }
    finally { rt.line = savedLine; rt.file = savedFile; }
    return;
  }
  if (r !== false) throw at(`Could not check compatibility between ${sigStr(csig)} and ${sigStr(psig)}, because class ${r} is not available`);
  throw at(`Declaration of ${sigStr(csig)} must be compatible with ${sigStr(psig)}`);
}
// The checks that named undeclared classes, after the class was registered: autoload the
// classes, then check again (zend_do_link_class: load_delayed_classes)
export function checkDelayed(cls, autoload) {
  const list = cls.delayedChecks;
  if (!list) return;
  cls.delayedChecks = null;
  const ctx = { resolve: (n) => autoload(n) };
  for (const { child, csig, psig } of list) report(child, csig, psig, compatible(csig, psig, ctx));
}
