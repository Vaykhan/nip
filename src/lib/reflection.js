// Reflection. The classes are declared in src/prelude/reflection.php with PHP's signatures; their
// methods call __refl_init() (constructors) and __refl() (everything else), implemented here on
// top of the interpreter's class and function tables. The reflected entity is kept in a hidden JS
// field (`refl`) of the PHP object, so it never shows up as a PHP property.

import { Flt, normKey, PHPArray, PHPObject, Ref } from '../values.js';
import { toStr, typeOf } from '../convert.js';
import { Frame } from '../compiler/common.js';
import { cExpr } from '../compiler/expr.js';
import { rt } from '../runtime/state.js';
import { deprecated, PRELUDE_FILE, throwError } from '../runtime/errors.js';
import { callFunction, coercePropType, typeParts, typeStr } from '../runtime/functions.js';
import { makeClosure } from '../runtime/callables.js';
import {
  classConst, initProps, instantiate, isInternalName, lookupClass, lookupStaticProp, propDefault, readProp,
  trackDestructible, writeProp,
} from '../runtime/classes.js';
import { LAZY_SKIP_DESTRUCTOR, LAZY_SKIP_SERIALIZE, lazyInit, lazyRealize, lazyRunning, makeLazy } from '../runtime/lazy.js';
import { initThrowable } from '../runtime/errors.js';
import { closureClass } from '../runtime/native-classes.js';
import { lazyFn } from '../runtime/boot.js';
import { def, deref, pnamesOf } from './core.js';
import { internalMethodSig } from '../runtime/inheritance.js';
import { CLASS_ARGINFO } from '../runtime/arginfo.js';
import { parsePHP } from '../parser.js';
import { dropRef, gcCheck } from '../runtime/gc.js';

const IS_STATIC = 16, IS_PUBLIC = 1, IS_PROTECTED = 2, IS_PRIVATE = 4, IS_ABSTRACT = 64, IS_FINAL = 32;
const IS_READONLY = 128, IS_READONLY_CLASS = 65536, IS_EXPLICIT_ABSTRACT = 64;
const VIS_BITS = { public: IS_PUBLIC, protected: IS_PROTECTED, private: IS_PRIVATE };
export const ATTR_TARGET = { class: 1, function: 2, method: 4, property: 8, 'class constant': 16, parameter: 32, constant: 64 };
// (PHP 8.5 added Attribute::TARGET_CONSTANT, which moved IS_REPEATABLE)
const attrAll = () => (rt.phpVersion >= 80500 ? 127 : 63), attrRepeatable = () => (rt.phpVersion >= 80500 ? 128 : 64);
const targetNames = () => Object.entries(ATTR_TARGET).filter(([, b]) => b !== 64 || rt.phpVersion >= 80500);
const ATTR_IS_INSTANCEOF = 2;

const reflErr = (msg) => throwError('ReflectionException', msg);
const lc = (s) => s.toLowerCase();
const strip = (n) => (n[0] === '\\' ? n.slice(1) : n);
const php = (v) => (v === undefined ? null : v);
const list = (a) => PHPArray.from(a);
const assoc = (pairs) => PHPArray.fromPairs(pairs);
const scopeFrame = (cls, fn) => new Frame(fn || null, null, cls || null, cls || null);

function refl(o) {
  if (!(o instanceof PHPObject) || !o.refl) throwError('Error', 'Internal error: Failed to retrieve the reflection object');
  return o.refl;
}
// a Reflection* object for `r`, created without calling its constructor
function mk(className, r, props) {
  const o = new PHPObject(lookupClass(className));
  initProps(o);
  for (const k in props) o.props.set(k, props[k]);
  o.refl = r;
  return o;
}
const isUserClass = (cls) => !!cls.decl && cls.decl.file !== PRELUDE_FILE;
const isInternalFn = (fn) => fn.native !== undefined || fn.file === PRELUDE_FILE;
// array of values -> call arguments (string keys become named arguments)
function callArgs(arr) {
  const out = [];
  if (!(arr instanceof PHPArray)) return out;
  for (const [k, v] of arr.entries()) {
    if (typeof k === 'string') { if (!out.named) out.named = new Map(); out.named.set(k, v); }
    else { if (out.named) throwError('Error', 'Cannot use positional argument after named argument'); out.push(v); }
  }
  return out;
}

// ---------------------------------------------------------------- object factories
export const classObj = (cls) => mk('ReflectionClass', { k: 'class', cls, obj: null }, { name: cls.name });
const methodObj = (cls, m) => mk('ReflectionMethod', { k: 'method', fn: m.fn, m, cls: m.cls, via: cls }, { name: m.name, class: m.cls.name });
const fnObj = (fn, closure) => mk('ReflectionFunction', { k: 'fn', fn, closure: closure || null }, { name: fnName(fn) });
const constObj = (cls, name, entry, as) => mk(as || 'ReflectionClassConstant', { k: 'const', cls: entry.cls, name, entry }, { name, class: entry.cls.name });
function caseObj(cls, name) {
  const entry = cls.consts.get(name);
  return constObj(cls, name, entry, cls.enumBacked ? 'ReflectionEnumBackedCase' : 'ReflectionEnumUnitCase');
}
function propObj(r) { return mk('ReflectionProperty', r, { name: r.name, class: r.cls.name }); }
function fnName(fn) { return fn.name; }

// ---------------------------------------------------------------- types
// t: { alts, nullable } as produced by the parser
function typeObj(t) {
  if (!t) return null;
  const alts = t.alts;
  if (alts.length === 1 && typeof alts[0] === 'object' && !t.nullable) return mk('ReflectionIntersectionType', { k: 'type', inter: alts[0].inter }, {});
  if (alts.includes('mixed')) return namedType('mixed', true);
  const parts = typeParts(t, null, true);
  if (parts.length === 1 && typeof parts[0] === 'string') return namedType(parts[0], t.nullable);
  if (parts.length === 0) return namedType('null', true);
  return mk('ReflectionUnionType', { k: 'type', union: parts, nullable: t.nullable, t }, {});
}
const BUILTIN = new Set(['int', 'float', 'string', 'bool', 'array', 'object', 'callable', 'iterable', 'mixed', 'void', 'never', 'null', 'false', 'true']);
function namedType(name, nullable) { return mk('ReflectionNamedType', { k: 'type', named: name, nullable: !!nullable }, {}); }
const TYPE_OPS = {
  allowsNull: (r) => (r.named !== undefined ? r.nullable || r.named === 'mixed' || r.named === 'null' : !!r.nullable),
  __toString(r) {
    if (r.named !== undefined) return (r.nullable && r.named !== 'mixed' && r.named !== 'null' ? '?' : '') + r.named;
    if (r.inter) return r.inter.join('&');
    return typeStr(r.t, null, true);
  },
  getName: (r) => r.named,
  isBuiltin: (r) => BUILTIN.has(r.named),
  getTypes(r) {
    if (r.inter) return list(r.inter.map((n) => namedType(n, false)));
    const out = r.union.map((p) => (typeof p === 'string' ? namedType(p, false) : mk('ReflectionIntersectionType', { k: 'type', inter: p }, {})));
    if (r.nullable) out.push(namedType('null', true));
    return list(out);
  },
};

// ---------------------------------------------------------------- attributes
// attrs: [{ name, args, l }] from the parser; scope: class whose constants the arguments may use
function attrList(attrs, target, scope, name, flags, who) {
  if (flags !== 0 && flags !== ATTR_IS_INSTANCEOF) throwError('ValueError', `${who}::getAttributes(): Argument #2 ($flags) must be a valid attribute filter flag`);
  if (!attrs) return new PHPArray();
  let filter = null;
  if (name !== null) {
    if (flags & ATTR_IS_INSTANCEOF) { const want = lookupClass(strip(name)); filter = (a) => { const c = lookupClass(a.name, true); return !!c && c.ancestors.has(want.lname); }; }
    else { const ln = lc(strip(name)); filter = (a) => lc(a.name) === ln; }
  }
  const counts = new Map();
  for (const a of attrs) counts.set(lc(a.name), (counts.get(lc(a.name)) || 0) + 1);
  // (PHP 8.4: with a public $name)
  return list(attrs.filter((a) => !filter || filter(a)).map((a) => mk('ReflectionAttribute', { k: 'attr', a, target, scope, repeated: counts.get(lc(a.name)) > 1 }, rt.phpVersion >= 80400 ? { name: ATTR_OPS.getName({ a }) } : {})));
}
function attrArgs(r) {
  const out = new PHPArray();
  const f = scopeFrame(r.scope);
  for (const arg of r.a.args) {
    const v = cExpr(arg.e)(f);
    if (arg.name) out.set(arg.name, v); else out.push(v);
  }
  return out;
}
const INTERNAL_ATTRS = { attribute: 1, returntypewillchange: 4, allowdynamicproperties: 1, sensitiveparameter: 32, override: 4, nodiscard: 6 };
// the Attribute flags of an attribute class, or null if it isn't one
export function attributeFlags(cls) {
  if (!isUserClass(cls)) {
    if (INTERNAL_ATTRS[cls.lname] !== undefined) return INTERNAL_ATTRS[cls.lname];
    if (cls.lname === 'deprecated') return rt.phpVersion >= 80500 ? 87 : 22; // (PHP 8.5: also constants and traits)
  }
  const a = cls.decl && cls.decl.attrs && cls.decl.attrs.find((x) => lc(strip(x.name)) === 'attribute');
  if (!a) return null;
  if (!a.args.length) return attrAll();
  return Number(cExpr(a.args[0].e)(scopeFrame(cls)));
}
const ATTR_OPS = {
  getName: (r) => r.a.name,
  getTarget: (r) => r.target,
  isRepeated: (r) => r.repeated,
  getArguments: (r) => attrArgs(r),
  newInstance(r) {
    const cls = lookupClass(r.a.name, true);
    if (!cls) throwError('Error', `Attribute class "${r.a.name}" not found`);
    const flags = attributeFlags(cls);
    if (flags === null) throwError('Error', `Attempting to use non-attribute class "${cls.name}" as attribute`);
    if (!(flags & r.target)) {
      const allowed = targetNames().filter(([, b]) => flags & b).map(([n]) => n).join(', ');
      const tname = targetNames().find(([, b]) => b === r.target)[0];
      throwError('Error', `Attribute "${cls.name}" cannot target ${tname} (allowed targets: ${allowed})`);
    }
    if (r.repeated && !(flags & attrRepeatable())) throwError('Error', `Attribute "${cls.name}" must not be repeated`);
    return instantiate(cls, () => callArgs(attrArgs(r)), null);
  },
  __toString(r) {
    const args = attrArgs(r);
    let s = `Attribute [ ${r.a.name} ]`;
    if (args.size) {
      s += ` {\n  - Arguments [${args.size}] {\n`;
      let i = 0;
      for (const [k, v] of args.entries()) s += `    Argument #${i++} [ ${typeof k === 'string' ? k + ' = ' : ''}${exportValue(v)} ]\n`;
      s += '  }\n}';
    }
    return s + '\n';
  },
};

// ---------------------------------------------------------------- functions and methods
// PHP's arginfo for methods of internal classes (NIP's implementations of them may declare
// other parameter names and types), or null
function internalArgs(fr) {
  if (!fr || fr.k !== 'method' || !isInternalFn(fr.fn)) return null;
  const m = fr.m;
  if (m.reflSig === undefined) m.reflSig = internalMethodSig(m.cls, lc(m.name));
  const sig = m.reflSig;
  if (sig && !sig.reflParams) {
    sig.reflParams = sig.params.map((p) => ({ name: p.name, byRef: p.byRef, variadic: p.variadic, type: p.type, promote: null, native: true, optional: p.optional, rawDef: p.def }));
    sig.required = 0;
    sig.params.forEach((p, i) => { if (!p.optional && !p.variadic) sig.required = i + 1; });
  }
  return sig;
}
// an arginfo default value ("null", "[]", "SORT_REGULAR", ...) evaluated
function rawDefault(raw) {
  try { return cExpr(parsePHP('<?php ' + raw + ';', PRELUDE_FILE)[0].e)(new Frame(null, null, null, null)); } catch (e) { return undefined; }
}
function reflParams(fn, fr) {
  const ai = internalArgs(fr);
  if (ai) return ai.reflParams;
  if (fn.native === undefined) return fn.params;
  if (!fn.reflParams) {
    const names = fn.pnames || pnamesOf(fn.native);
    const defs = nativeDefaults(fn.native);
    const off = fn.frame ? 1 : 0;
    fn.reflParams = names.map((name, i) => ({
      name, byRef: !!((fn.refs && fn.refs[i]) || (fn.refRest !== null && fn.refRest !== undefined && i >= fn.refRest)),
      variadic: fn.max === Infinity && i === names.length - 1, type: null, promote: null, native: true,
      optional: i >= fn.min, nativeDef: defs[i + off],
    }));
  }
  return fn.reflParams;
}
// default values of a builtin, from its JS parameter list (literals only)
function nativeDefaults(jsfn) {
  const m = /^[^(]*\(([^)]*)\)/.exec(jsfn.toString());
  if (!m) return [];
  return m[1].split(',').map((s) => {
    const d = /=\s*(.+)$/.exec(s.trim());
    if (!d) return undefined;
    const t = d[1].trim();
    if (t === 'null') return null;
    if (t === 'true' || t === 'false') return t === 'true';
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d*\.\d+$/.test(t)) return new Flt(Number(t));
    const q = /^(['"])(.*)\1$/.exec(t);
    if (q) return q[2];
    return undefined;
  });
}
function requiredCount(fn, fr) {
  const ai = internalArgs(fr);
  if (ai) return ai.required;
  if (fn.native !== undefined) return fn.min;
  const ps = fn.params;
  for (let i = ps.length - 1; i >= 0; i--) if (!ps[i].def && !ps[i].variadic) return i + 1;
  return 0;
}
function fnScope(r) { return r.k === 'method' ? r.cls : (r.closure ? r.closure.scope : null); }
function staticVars(r) {
  const fn = r.fn, out = new PHPArray();
  if (r.closure && r.closure.bound) for (const [k, v] of r.closure.bound) out.set(k, deref(v));
  if (fn.native !== undefined || !fn.decl) return out;
  // see the StaticVar statement: closures keep them on the closure object, methods per called class
  const store = r.closure ? r.closure.statics : r.m && fn.staticsByClass ? fn.staticsByClass.get(r.via) : fn.statics;
  const seen = new Set();
  const walk = (list) => {
    for (const s of list || []) {
      if (!s || typeof s !== 'object') continue;
      if (s.k === 'StaticVar') {
        for (const v of s.vars) {
          if (seen.has(v.name)) continue;
          seen.add(v.name);
          const cur = store ? store.get(v.name) : undefined;
          out.set(v.name, cur !== undefined ? deref(cur) : (v.init ? cExpr(v.init)(scopeFrame(fnScope(r), fn)) : null));
        }
      }
      for (const key of ['body', 'then', 'els', 'elifs', 'cases', 'catches', 'fin']) {
        const c = s[key];
        if (Array.isArray(c)) walk(c); else if (c && typeof c === 'object') walk(c.k ? [c] : c.body || []);
      }
    }
  };
  walk(fn.decl.body);
  return out;
}
function reflInvoke(r, thisObj, args) {
  if (r.k === 'method') {
    const m = r.m;
    if (m.abstract) reflErr(`Trying to invoke abstract method ${m.cls.name}::${m.name}()`);
    if (m.static) return callFunction(m.fn, args, null, m.cls, m.cls, null);
    if (!(thisObj instanceof PHPObject)) reflErr(`Trying to invoke non static method ${m.cls.name}::${m.name}() without an object`);
    if (!thisObj.cls.ancestors.has(m.cls.lname)) reflErr('Given object is not an instance of the class this method was declared in');
    return callFunction(m.fn, args, thisObj, m.cls, thisObj.cls, null);
  }
  const c = r.closure;
  if (c) return callFunction(c.fn, args, c.thisObj, c.scope, c.sc, c);
  return callFunction(r.fn, args, null, null, null, null);
}
const FN_OPS = {
  inNamespace: (r) => r.k !== 'method' && !r.closure && r.fn.name.includes('\\'),
  isClosure: (r) => !!r.closure && r.closure.fn.isClosure,
  isDeprecated: () => false,
  isInternal: (r) => isInternalFn(r.fn),
  isUserDefined: (r) => !isInternalFn(r.fn),
  isGenerator: (r) => !!r.fn.isGen,
  isVariadic: (r) => reflParams(r.fn, r).some((p) => p.variadic),
  isStatic: (r) => (r.k === 'method' ? !!r.m.static : !!(r.fn.decl && r.fn.decl.static)),
  getClosureThis: (r) => (r.closure ? r.closure.thisObj || null : null),
  getClosureScopeClass: (r) => (r.closure && r.closure.scope ? classObj(r.closure.scope) : null),
  getClosureCalledClass: (r) => (r.closure && (r.closure.sc || r.closure.scope) ? classObj(r.closure.sc || r.closure.scope) : null),
  getClosureUsedVariables(r) {
    const out = new PHPArray();
    // variables used by reference keep their reference
    if (r.closure && r.closure.bound) for (const [k, v] of r.closure.bound) { if (v instanceof Ref) out.setRaw(normKey(k), v); else out.set(k, v); }
    return out;
  },
  getDocComment: (r) => (r.fn.decl && r.fn.decl.doc) || false,
  getEndLine: (r) => (isInternalFn(r.fn) ? false : r.fn.decl.endLine || r.fn.line),
  getExtension: () => null,
  getExtensionName: (r) => (isInternalFn(r.fn) ? 'standard' : false),
  getFileName: (r) => (isInternalFn(r.fn) ? false : r.fn.file),
  getName: (r) => (r.k === 'method' ? r.m.name : fnName(r.fn)),
  getNamespaceName: (r) => { const n = FN_OPS.getName(r); const i = n.lastIndexOf('\\'); return r.k === 'method' || i < 0 ? '' : n.slice(0, i); },
  getShortName: (r) => { const n = FN_OPS.getName(r); return r.k === 'method' ? n : n.slice(n.lastIndexOf('\\') + 1); },
  getNumberOfParameters: (r) => reflParams(r.fn, r).length,
  getNumberOfRequiredParameters: (r) => requiredCount(r.fn, r),
  getParameters: (r) => list(reflParams(r.fn, r).map((p, i) => mk('ReflectionParameter', { k: 'param', fr: r, i }, { name: p.name }))),
  getStaticVariables: (r) => staticVars(r),
  returnsReference: (r) => !!r.fn.byRef,
  hasReturnType: (r) => { const ai = internalArgs(r); return ai ? !!ai.ret && !ai.tentative : !!r.fn.ret; },
  getReturnType: (r) => { const ai = internalArgs(r); return ai ? (ai.tentative ? null : typeObj(ai.ret)) : typeObj(r.fn.ret); },
  hasTentativeReturnType: (r) => { const ai = internalArgs(r); return !!ai && !!ai.ret && ai.tentative; },
  getTentativeReturnType: (r) => { const ai = internalArgs(r); return ai && ai.tentative ? typeObj(ai.ret) : null; },
  getAttributes: (r, name, flags) => attrList(r.fn.decl && r.fn.decl.attrs, r.k === 'method' ? ATTR_TARGET.method : ATTR_TARGET.function, fnScope(r), name, flags, 'ReflectionFunctionAbstract'),
  __toString: (r) => fnToString(r),
};
const FUNCTION_OPS = Object.assign(Object.create(FN_OPS), {
  isAnonymous: (r) => !!r.closure && r.closure.fn.isClosure,
  isDisabled: () => { deprecated('Method ReflectionFunction::isDisabled() is deprecated'); return false; },
  invoke: (r, args) => reflInvoke(r, null, callArgs(args)),
  invokeArgs: (r, args) => reflInvoke(r, null, callArgs(args)),
  getClosure: (r) => r.closure || makeClosure(r.fn, null, null, null, null),
});
const METHOD_OPS = Object.assign(Object.create(FN_OPS), {
  isPublic: (r) => r.m.vis === 'public',
  isPrivate: (r) => r.m.vis === 'private',
  isProtected: (r) => r.m.vis === 'protected',
  isAbstract: (r) => !!r.m.abstract,
  isFinal: (r) => !!r.m.final,
  isConstructor: (r) => lc(r.m.name) === '__construct',
  isDestructor: (r) => lc(r.m.name) === '__destruct',
  getModifiers: (r) => methodModifiers(r.m),
  getDeclaringClass: (r) => classObj(r.m.cls),
  getClosure(r, obj) {
    const m = r.m;
    if (m.static) return makeClosure(m.fn, null, null, m.cls, m.cls);
    if (!(obj instanceof PHPObject)) throwError('ArgumentCountError', 'ReflectionMethod::getClosure() expects exactly 1 argument, 0 given');
    if (!obj.cls.ancestors.has(m.cls.lname)) reflErr('Given object is not an instance of the class this method was declared in');
    return makeClosure(m.fn, null, obj, m.cls, obj.cls);
  },
  invoke: (r, obj, args) => reflInvoke(r, obj, callArgs(args)),
  invokeArgs: (r, obj, args) => reflInvoke(r, obj, callArgs(args)),
  hasPrototype: (r) => !!r.m.proto,
  getPrototype(r) {
    const p = r.m.proto;
    const pm = p && p.methods.get(lc(r.m.name));
    if (!pm) reflErr(`Method ${r.via.name}::${r.m.name} does not have a prototype`);
    return methodObj(p, pm);
  },
  setAccessible: () => { if (rt.phpVersion >= 80500) deprecated('Method ReflectionMethod::setAccessible() is deprecated since 8.5, as it has no effect'); return null; },
});
function methodModifiers(m) {
  return VIS_BITS[m.vis] | (m.static ? IS_STATIC : 0) | (m.abstract ? IS_ABSTRACT : 0) | (m.final ? IS_FINAL : 0);
}

// ---------------------------------------------------------------- parameters
const reflParam = (r) => reflParams(r.fr.fn, r.fr)[r.i];
function paramDefaultAvailable(r) {
  const p = reflParam(r);
  if (p.variadic) return false;
  if (p.rawDef !== undefined) return p.rawDef !== null;
  return p.native ? p.nativeDef !== undefined : !!p.defNode;
}
const PARAM_OPS = {
  getName: (r) => reflParam(r).name,
  isPassedByReference: (r) => !!reflParam(r).byRef,
  canBePassedByValue: (r) => !reflParam(r).byRef,
  getDeclaringFunction: (r) => (r.fr.k === 'method' ? methodObj(r.fr.cls, r.fr.m) : fnObj(r.fr.fn, r.fr.closure)),
  getDeclaringClass: (r) => { const c = fnScope(r.fr); return c ? classObj(c) : null; },
  getClass(r) {
    deprecated('Method ReflectionParameter::getClass() is deprecated');
    const t = reflParam(r).type;
    if (!t || t.alts.length !== 1 || typeof t.alts[0] !== 'string' || BUILTIN.has(t.alts[0])) return null;
    let n = t.alts[0];
    const scope = fnScope(r.fr);
    if (n === 'self' && scope) return classObj(scope);
    if (n === 'parent' && scope && scope.parent) return classObj(scope.parent);
    const c = lookupClass(n, true);
    if (!c) reflErr(`Class "${n}" does not exist`);
    return classObj(c);
  },
  hasType: (r) => !!reflParam(r).type,
  getType: (r) => typeObj(reflParam(r).type),
  isArray: (r) => { deprecated('Method ReflectionParameter::isArray() is deprecated'); const t = reflParam(r).type; return !!t && t.alts.length === 1 && t.alts[0] === 'array'; },
  isCallable: (r) => { deprecated('Method ReflectionParameter::isCallable() is deprecated'); const t = reflParam(r).type; return !!t && t.alts.length === 1 && t.alts[0] === 'callable'; },
  allowsNull: (r) => { const t = reflParam(r).type; return !t || t.nullable || t.alts.includes('mixed'); },
  getPosition: (r) => r.i,
  isOptional: (r) => r.i >= requiredCount(r.fr.fn, r.fr),
  isDefaultValueAvailable: (r) => paramDefaultAvailable(r),
  getDefaultValue(r) {
    if (!paramDefaultAvailable(r)) reflErr('Internal error: Failed to retrieve the default value');
    const p = reflParam(r);
    if (p.rawDef !== undefined) return rawDefault(p.rawDef);
    if (p.native) return p.nativeDef;
    return p.def(scopeFrame(fnScope(r.fr), r.fr.fn));
  },
  isDefaultValueConstant(r) {
    if (!paramDefaultAvailable(r)) reflErr('Internal error: Failed to retrieve the default value');
    const raw = reflParam(r).rawDef;
    if (raw) return /^\\?[A-Za-z_][\w\\]*(::[A-Za-z_]\w*)?$/.test(raw) && !['null', 'true', 'false'].includes(lc(raw));
    const d = reflParam(r).defNode;
    return !!d && (d.k === 'Const' || d.k === 'CConst');
  },
  getDefaultValueConstantName(r) {
    if (!paramDefaultAvailable(r)) reflErr('Internal error: Failed to retrieve the default value');
    if (reflParam(r).rawDef) return PARAM_OPS.isDefaultValueConstant(r) ? reflParam(r).rawDef.replace(/^\\/, '') : null;
    const d = reflParam(r).defNode;
    if (!d) return null;
    if (d.k === 'Const') return d.fb && !rt.consts.has(d.name) ? d.fb : d.name;
    if (d.k === 'CConst') return `${typeof d.cls === 'string' ? d.cls : '?'}::${d.name}`;
    return null;
  },
  isVariadic: (r) => !!reflParam(r).variadic,
  isPromoted: (r) => !!reflParam(r).promote,
  getAttributes: (r, name, flags) => attrList(reflParam(r).native ? null : r.fr.fn.decl.params[r.i].attrs, ATTR_TARGET.parameter, fnScope(r.fr), name, flags, 'ReflectionParameter'),
  __toString: (r) => paramToString(r),
};

// ---------------------------------------------------------------- classes
// methods in PHP's order: declared in the class body, then imported from traits (and other own
// methods), then inherited ones (parent's order), then interface methods; parents' private
// methods are not included
function methodOrder(cls) {
  const out = [], seen = new Set();
  const add = (m) => { const ln = lc(m.name); if (seen.has(ln) || cls.methods.get(ln) !== m) return; seen.add(ln); out.push(m); };
  if (cls.decl) for (const d of cls.decl.methods) { const m = cls.methods.get(lc(d.fn.name)); if (m && m.cls === cls) add(m); }
  for (const m of cls.methods.values()) if (m.cls === cls) add(m);
  if (cls.parent) for (const m of methodOrder(cls.parent)) if (m.vis !== 'private' || m.cls === cls) add(m);
  for (const m of cls.methods.values()) if (m.vis !== 'private' || m.cls === cls) add(m);
  return out.filter((m) => !isInternalName(m.cls, m.name));
}
// properties in PHP's order: declared (with promoted constructor parameters), inherited, then
// trait properties; each entry { name, info, isStatic }
function propOrder(cls) {
  const out = [], seen = new Set();
  const add = (name, isStatic) => {
    if (seen.has(name)) return;
    const info = isStatic ? cls.sprops.get(name) : cls.props.get(name);
    if (!info || (info.vis === 'private' && info.cls !== cls) || info.internal) return;
    seen.add(name);
    out.push({ name, info, isStatic });
  };
  if (cls.decl) {
    // promoted constructor parameters count as declared where the constructor is
    const own = cls.decl.props.map((p) => [p.seq, p.name, p.static]);
    const ctor = cls.decl.methods.find((m) => lc(m.fn.name) === '__construct');
    if (ctor) for (const p of ctor.fn.params) if (p.promote) own.push([ctor.seq, p.name, false]);
    own.sort((a, b) => a[0] - b[0]);
    for (const [, name, isStatic] of own) add(name, isStatic);
  }
  if (cls.parent) for (const p of propOrder(cls.parent)) add(p.name, p.isStatic);
  for (const [name] of cls.props) add(name, false);
  for (const [name] of cls.sprops) add(name, true);
  return out;
}
// constants (and enum cases) in declaration order, then inherited ones
function constOrder(cls) {
  const out = [], seen = new Set();
  const add = (name) => {
    const e = cls.consts.get(name);
    if (!e || seen.has(name) || (e.vis === 'private' && e.cls !== cls)) return;
    seen.add(name); out.push([name, e]);
  };
  if (cls.decl) {
    const own = [...cls.decl.consts, ...cls.decl.cases].sort((a, b) => a.seq - b.seq);
    for (const c of own) add(c.name);
  }
  if (cls.parent) for (const [name] of constOrder(cls.parent)) add(name);
  for (const [name] of cls.consts) add(name);
  return out;
}
function interfaceOrder(cls) {
  const out = [], seen = new Set();
  const visit = (i) => { if (seen.has(i.lname)) return; seen.add(i.lname); out.push(i); };
  for (const i of cls.ifaceList) visit(i);
  for (const a of cls.ancestors) { const c = rt.classes.get(a); if (c && c.isInterface && c !== cls) visit(c); }
  return out;
}
function traitList(cls) {
  if (!cls.decl) return [];
  const out = [];
  for (const tu of cls.decl.traits) for (const n of tu.names) { const t = lookupClass(n, true); if (t && !out.includes(t)) out.push(t); }
  return out;
}
function classModifiers(cls) {
  if (cls.isInterface || cls.isTrait) return 0;
  return (cls.abstract ? IS_EXPLICIT_ABSTRACT : 0) | (cls.final || cls.isEnum ? IS_FINAL : 0) | (cls.readonly ? IS_READONLY_CLASS : 0);
}
function reflFindMethod(cls, name) {
  const m = cls.methods.get(lc(name));
  return m && !isInternalName(m.cls, m.name) ? m : null;
}
function reflFindProp(r, name) {
  const cls = r.cls;
  const si = cls.sprops.get(name);
  if (si && !(si.vis === 'private' && si.cls !== cls) && !si.internal) return { k: 'prop', cls: si.cls, name, info: si, isStatic: true };
  const info = cls.props.get(name);
  if (info && !info.internal) return { k: 'prop', cls: info.cls, name, info, isStatic: false };
  if (r.obj && r.obj.props.has(name) && !cls.slots.has(name)) return { k: 'prop', cls, name, info: null, isStatic: false, dyn: true };
  return null;
}
function resolveClassArg(v) {
  if (v instanceof PHPObject) { if (v.refl && v.refl.k === 'class') return v.refl.cls; return v.cls; }
  const c = lookupClass(strip(toStr(v)), true);
  if (!c) reflErr(`Class "${strip(toStr(v))}" does not exist`);
  return c;
}
function staticValue(si) { const s = lookupStaticProp(si.cls, si.name) || si; return deref(s.ref); }
const CLASS_OPS = {
  getName: (r) => r.cls.name,
  isInternal: (r) => !isUserClass(r.cls),
  isUserDefined: (r) => isUserClass(r.cls),
  isAnonymous: (r) => !!r.cls.anon,
  isInstantiable(r) {
    const c = r.cls;
    if (c.abstract || c.isInterface || c.isTrait || c.isEnum) return false;
    const ctor = c.methods.get('__construct');
    return !ctor || ctor.vis === 'public';
  },
  isCloneable(r) {
    const c = r.cls;
    if (c.abstract || c.isInterface || c.isTrait || c.isEnum || c === closureClass || c.lname === 'generator') return false;
    const m = c.methods.get('__clone');
    if (m && m.vis === 'private' && !isUserClass(m.cls)) return false;
    return !m || m.vis === 'public';
  },
  getFileName: (r) => (isUserClass(r.cls) ? r.cls.decl.file : false),
  getStartLine: (r) => (isUserClass(r.cls) ? r.cls.decl.startLine || r.cls.decl.l : false),
  getEndLine: (r) => (isUserClass(r.cls) ? r.cls.decl.endLine : false),
  getDocComment: (r) => (r.cls.decl && r.cls.decl.doc) || false,
  getConstructor: (r) => { const m = reflFindMethod(r.cls, '__construct'); return m ? methodObj(r.cls, m) : null; },
  hasMethod: (r, name) => !!reflFindMethod(r.cls, name),
  getMethod(r, name) {
    const m = reflFindMethod(r.cls, name);
    if (!m) reflErr(`Method ${r.cls.name}::${name}() does not exist`);
    return methodObj(r.cls, m);
  },
  getMethods: (r, filter) => list(methodOrder(r.cls).filter((m) => filter === null || (methodModifiers(m) & filter)).map((m) => methodObj(r.cls, m))),
  hasProperty: (r, name) => !!reflFindProp(r, name),
  getProperty(r, name) {
    const p = reflFindProp(r, name);
    if (!p) reflErr(`Property ${r.cls.name}::$${name} does not exist`);
    return propObj(p);
  },
  getProperties(r, filter) {
    const out = [];
    for (const { name, info, isStatic } of propOrder(r.cls)) {
      const p = { k: 'prop', cls: info.cls, name, info, isStatic };
      if (filter === null || (propModifiers(p) & filter)) out.push(propObj(p));
    }
    if (r.obj && (filter === null || (filter & IS_PUBLIC))) {
      for (const [k] of r.obj.props) if (!r.cls.slots.has(k) && k.charCodeAt(0) !== 0) out.push(propObj({ k: 'prop', cls: r.cls, name: k, info: null, isStatic: false, dyn: true }));
    }
    return list(out);
  },
  hasConstant: (r, name) => constOrder(r.cls).some(([n]) => n === name),
  getConstants: (r, filter) => assoc(constOrder(r.cls).filter(([, e]) => filter === null || (constModifiers(e) & filter)).map(([n]) => [n, classConst(r.cls, n)])),
  getReflectionConstants: (r, filter) => list(constOrder(r.cls).filter(([, e]) => filter === null || (constModifiers(e) & filter)).map(([n, e]) => constObj(r.cls, n, e))),
  getConstant: (r, name) => (constOrder(r.cls).some(([n]) => n === name) ? classConst(r.cls, name) : false),
  getReflectionConstant(r, name) {
    const e = constOrder(r.cls).find(([n]) => n === name);
    return e ? constObj(r.cls, name, e[1]) : false;
  },
  getInterfaces: (r) => assoc(interfaceOrder(r.cls).map((i) => [i.name, classObj(i)])),
  getInterfaceNames: (r) => list(interfaceOrder(r.cls).map((i) => i.name)),
  isInterface: (r) => !!r.cls.isInterface,
  getTraits: (r) => assoc(traitList(r.cls).map((t) => [t.name, classObj(t)])),
  getTraitNames: (r) => list(traitList(r.cls).map((t) => t.name)),
  getTraitAliases(r) {
    const out = new PHPArray();
    if (!r.cls.decl) return out;
    for (const tu of r.cls.decl.traits) {
      for (const rule of tu.rules) {
        if (rule.kind !== 'as' || !rule.alias) continue;
        let t = rule.trait;
        if (!t) for (const n of tu.names) { const tc = lookupClass(n, true); if (tc && tc.methods.has(lc(rule.method))) { t = tc.name; break; } }
        out.set(rule.alias, `${t}::${rule.method}`);
      }
    }
    return out;
  },
  isTrait: (r) => !!r.cls.isTrait,
  isEnum: (r) => !!r.cls.isEnum,
  isAbstract: (r) => !!r.cls.abstract || (!!r.cls.isInterface && [...r.cls.methods.values()].some((m) => m.abstract)) || (!!r.cls.isTrait && [...r.cls.methods.values()].some((m) => m.abstract)),
  isFinal: (r) => !!r.cls.final || !!r.cls.isEnum,
  isReadOnly: (r) => !!r.cls.readonly,
  getModifiers: (r) => classModifiers(r.cls),
  isInstance: (r, obj) => obj.cls.ancestors.has(r.cls.lname),
  newInstance: (r, args) => newInstance(r.cls, callArgs(args)),
  newInstanceArgs: (r, args) => newInstance(r.cls, callArgs(args)),
  newInstanceWithoutConstructor(r) {
    const c = r.cls;
    if (!isUserClass(c) && c.final && c.lname !== 'stdclass') reflErr(`Class ${c.name} is an internal class marked as final that cannot be instantiated without invoking its constructor`);
    if (c.abstract || c.isInterface || c.isTrait || c.isEnum) {
      const what = c.isInterface ? 'interface' : c.isTrait ? 'trait' : c.isEnum ? 'enum' : 'abstract class';
      throwError('Error', `Cannot instantiate ${what} ${c.name}`);
    }
    const o = new PHPObject(c);
    initProps(o);
    if (c.ancestors.has('throwable')) initThrowable(o);
    return o;
  },
  newLazyGhost: (r, init, options) => newLazy(r, init, options, false),
  newLazyProxy: (r, init, options) => newLazy(r, init, options, true),
  resetAsLazyGhost: (r, obj, init, options) => resetAsLazy(r, obj, init, options, false),
  resetAsLazyProxy: (r, obj, init, options) => resetAsLazy(r, obj, init, options, true),
  initializeLazyObject: (r, obj) => { lazyArg(r, obj, 'initializeLazyObject'); return obj.lazy === undefined ? obj : lazyInit(obj); },
  isUninitializedLazyObject: (r, obj) => { lazyArg(r, obj, 'isUninitializedLazyObject'); return obj.lazy !== undefined && obj.lazy.instance === null; },
  markLazyObjectAsInitialized(r, obj) {
    lazyArg(r, obj, 'markLazyObjectAsInitialized');
    const lz = obj.lazy;
    if (lz === undefined || lz.instance !== null) return obj;
    for (const key of [...lz.keys]) lazySkip(obj, obj.cls.slots.get(key));
    obj.lazy = undefined;
    return obj;
  },
  getLazyInitializer: (r, obj) => { lazyArg(r, obj, 'getLazyInitializer'); return obj.lazy !== undefined && obj.lazy.instance === null ? obj.lazy.init : null; },
  getParentClass: (r) => (r.cls.parent ? classObj(r.cls.parent) : false),
  isSubclassOf(r, other) {
    const c = resolveClassArg(other);
    return c !== r.cls && r.cls.ancestors.has(c.lname);
  },
  getStaticProperties(r) {
    const out = new PHPArray();
    for (const p of propOrder(r.cls)) if (p.isStatic) out.set(p.name, staticValue(p.info));
    return out;
  },
  getStaticPropertyValue(r, name, ...dflt) {
    const si = r.cls.sprops.get(name);
    if (!si || si.internal || (si.vis === 'private' && si.cls !== r.cls)) {
      if (dflt.length) return dflt[0];
      reflErr(`Property ${r.cls.name}::$${name} does not exist`);
    }
    return staticValue(si);
  },
  setStaticPropertyValue(r, name, value) {
    const si = r.cls.sprops.get(name);
    if (!si || si.internal || (si.vis === 'private' && si.cls !== r.cls)) reflErr(`Class ${r.cls.name} does not have a property named ${name}`);
    lookupStaticProp(si.cls, si.name);
    si.ref.v = value;
    return null;
  },
  getDefaultProperties(r) {
    const out = new PHPArray();
    const order = propOrder(r.cls);
    for (const p of order) if (p.isStatic) out.set(p.name, propDefaultValue(p.info, true));
    for (const p of order) if (!p.isStatic && (p.info.hasDef || !p.info.type)) out.set(p.name, propDefaultValue(p.info, false));
    return out;
  },
  isIterable(r) {
    const c = r.cls;
    if (c.abstract || c.isInterface || c.isTrait) return false;
    return c.ancestors.has('traversable');
  },
  implementsInterface(r, iface) {
    const c = resolveClassArg(iface);
    if (!c.isInterface) reflErr(`${c.name} is not an interface`);
    return r.cls.ancestors.has(c.lname);
  },
  getExtension: (r) => (isUserClass(r.cls) ? null : extensionObj(classExtension(r.cls))),
  getExtensionName: (r) => (isUserClass(r.cls) ? false : classExtension(r.cls)),
  inNamespace: (r) => r.cls.name.includes('\\'),
  getNamespaceName: (r) => { const i = r.cls.name.lastIndexOf('\\'); return i < 0 ? '' : r.cls.name.slice(0, i); },
  getShortName: (r) => r.cls.name.slice(r.cls.name.lastIndexOf('\\') + 1),
  getAttributes: (r, name, flags) => attrList(r.cls.decl && r.cls.decl.attrs, ATTR_TARGET.class, r.cls, name, flags, 'ReflectionClass'),
  __toString: (r) => classToString(r),
  // ReflectionEnum
  hasCase: (r, name) => !!(r.cls.consts.get(name) || {}).case,
  getCase(r, name) {
    const e = r.cls.consts.get(name);
    if (!e) reflErr(`Case ${r.cls.name}::${name} does not exist`);
    if (!e.case) reflErr(`${r.cls.name}::${name} is not a case`);
    return caseObj(r.cls, name);
  },
  getCases: (r) => list(r.cls.cases.map((n) => caseObj(r.cls, n))),
  isBacked: (r) => !!r.cls.enumBacked,
  getBackingType: (r) => (r.cls.enumBacked ? namedType(r.cls.enumBacked, false) : null),
};
CLASS_OPS.isIterateable = CLASS_OPS.isIterable;
// the extension an internal class belongs to (approximated from its name)
function classExtension(cls) {
  const ai = CLASS_ARGINFO[cls.lname];
  if (ai) return ai[2];
  const n = cls.name;
  if (/^Reflect|^(Attribute|ReturnTypeWillChange|AllowDynamicProperties|SensitiveParameter(Value)?|Override)$/.test(n)) return /^Reflect/.test(n) ? 'Reflection' : 'Core';
  if (/^Date/.test(n)) return 'date';
  if (/^Spl|Iterator$|^ArrayObject$|^(LogicException|BadFunctionCallException|BadMethodCallException|DomainException|InvalidArgumentException|LengthException|OutOfRangeException|RuntimeException|OutOfBoundsException|OverflowException|RangeException|UnderflowException|UnexpectedValueException)$/.test(n) && n !== 'Iterator') return 'SPL';
  if (/^Json/.test(n)) return 'json';
  if (/^Random\\/.test(n)) return 'random';
  return 'Core';
}
export function extensionObj(name) {
  return mk('ReflectionExtension', { k: 'ext', name }, { name });
}
function newInstance(cls, args) {
  const ctor = cls.methods.get('__construct');
  if (ctor && ctor.vis !== 'public') reflErr(`Access to non-public constructor of class ${cls.name}`);
  if (!ctor && (args.length || args.named)) reflErr(`Class ${cls.name} does not have a constructor, so you cannot pass any constructor arguments`);
  return instantiate(cls, () => args, null);
}

// ---------------------------------------------------------------- lazy objects (PHP 8.4)
function lazyOptions(options, method, argNo, reset) {
  if (options & ~(LAZY_SKIP_SERIALIZE | LAZY_SKIP_DESTRUCTOR)) reflErr(`ReflectionClass::${method}(): Argument #${argNo} ($options) contains invalid flags`);
  if (!reset && options & LAZY_SKIP_DESTRUCTOR) reflErr(`ReflectionClass::${method}(): Argument #${argNo} ($options) does not accept ReflectionClass::SKIP_DESTRUCTOR`);
}
// internal classes (other than stdClass) and their subclasses can't be lazy
function lazyCheckClass(c) {
  for (let p = c; p; p = p.parent) {
    if (isUserClass(p) || p.lname === 'stdclass') continue;
    throwError('Error', `Cannot make instance of internal class lazy: ${p === c ? c.name + ' is internal' : c.name + ' inherits internal class ' + p.name}`);
  }
}
function lazyArg(r, obj, method) {
  if (!obj.cls.ancestors.has(r.cls.lname)) throwError('TypeError', `ReflectionClass::${method}(): Argument #1 ($object) must be of type ${r.cls.name}, ${obj.cls.name} given`);
}
function newLazy(r, init, options, proxy) {
  const c = r.cls;
  lazyOptions(options, proxy ? 'newLazyProxy' : 'newLazyGhost', 2, false);
  lazyCheckClass(c);
  if (c.abstract || c.isInterface || c.isTrait || c.isEnum) {
    const what = c.isInterface ? 'interface' : c.isTrait ? 'trait' : c.isEnum ? 'enum' : 'abstract class';
    throwError('Error', `Cannot instantiate ${what} ${c.name}`);
  }
  const o = new PHPObject(c);
  makeLazy(o, c, proxy, init, options);
  if (o.lazy === undefined) initProps(o);
  if (c.hasDestructor) trackDestructible(o);
  return o;
}
function resetAsLazy(r, obj, init, options, proxy) {
  const method = proxy ? 'resetAsLazyProxy' : 'resetAsLazyGhost';
  lazyArg(r, obj, method);
  lazyOptions(options, method, 3, true);
  lazyCheckClass(obj.cls);
  if (lazyRunning.has(obj)) throwError('Error', 'Can not reset an object while it is being initialized');
  if (obj.lazy !== undefined && obj.lazy.instance === null) reflErr('Object is already lazy');
  if (obj.lazy !== undefined) { const inst = obj.lazy.instance; obj.lazy = undefined; gcCheck(inst); } // (an initialized proxy lets go of its instance)
  if (!(options & LAZY_SKIP_DESTRUCTOR) && obj.lazy === undefined && !obj.destructed) {
    const m = obj.cls.methods.get('__destruct');
    if (m) { obj.destructed = true; callFunction(m.fn, [], obj, m.cls, obj.cls, null); }
  }
  obj.destructed = false;
  // the dynamic properties and the class's are reset (a subclass's are kept), except initialized
  // readonly ones of a final class or final readonly ones
  const keep = new Set();
  for (const key of [...obj.props.keys()]) {
    const info = obj.cls.slots.get(key);
    if (info !== undefined && !r.cls.slots.has(key)) continue;
    if (info !== undefined && info.readonly && (obj.cls.final || info.final)) { keep.add(key); continue; }
    obj.props.delete(key);
  }
  obj.lazy = undefined;
  makeLazy(obj, r.cls, proxy, init, options, keep);
  if (obj.lazy !== undefined) for (const key of [...obj.lazy.keys]) if (!obj.cls.slots.has(key)) obj.lazy.keys.delete(key);
}
// a lazy property gets its default value (or stays uninitialized when typed without one)
function lazySkip(obj, info) {
  if (!obj.props.has(info.key)) {
    if (info.hasDef) { const v = propDefault(info); if (v instanceof PHPArray) v.cow = true; obj.props.set(info.key, v); }
    else if (!info.type) obj.props.set(info.key, null);
  }
  lazyRealize(obj, info.key);
}
function lazyPropCheck(r, obj, method) {
  r = objProp(r, obj);
  const name = r.dyn ? r.cls.name : r.info.cls.name;
  if (r.isStatic) reflErr(`Can not use ${method} on static property ${name}::$${r.name}`);
  if (r.dyn) reflErr(`Can not use ${method} on dynamic property ${name}::$${r.name}`);
  if (r.info.virtual) reflErr(`Can not use ${method} on virtual property ${name}::$${r.name}`);
  if (!obj.cls.ancestors.has(r.cls.lname)) throwError('TypeError', `ReflectionProperty::${method}(): Argument #1 ($object) must be of type ${r.cls.name}, ${obj.cls.name} given`);
  return r;
}
// the property r names as the object's class declares it (a subclass may redeclare it, with or
// without hooks, or as a static property)
function objProp(r, obj) {
  if (r.isStatic || (!r.dyn && r.info.vis === 'private') || obj.cls === r.cls) return r;
  const i = obj.cls.props.get(r.name);
  if (i !== undefined) return i === r.info ? r : { ...r, info: i, dyn: false };
  const si = obj.cls.sprops.get(r.name);
  return si !== undefined ? { ...r, info: si, isStatic: true, dyn: false } : r;
}
// a frame in which property accesses of r bypass its hooks, as inside them
function rawFrame(r, obj) { return new Frame({ hookProp: r.name }, obj, r.cls, r.cls); }
// a property hook as a ReflectionMethod
const hookMethod = (r, fn) => methodObj(fn.cls, { name: fn.name, fn, cls: fn.cls, vis: 'public', static: false, abstract: !!fn.abstractHook, final: !!(fn.decl && fn.decl.final) });
// the slot a lazy-object operation on property r of obj works on: the object's own (a subclass may
// redeclare the property)
const lazyInfo = (r, obj) => obj.cls.slots.get(r.info.key) || r.info;

// ---------------------------------------------------------------- properties
function propModifiers(p) {
  if (p.dyn) return IS_PUBLIC;
  const i = p.info;
  return VIS_BITS[i.vis] | (p.isStatic ? IS_STATIC : 0) | (i.readonly ? IS_READONLY : 0) | (PROP_OPS.isAbstract(p) ? IS_ABSTRACT : 0) | (i.final ? IS_FINAL : 0)
    | (i.virtual ? 512 : 0) | (i.setVis === 'protected' ? 2048 : i.setVis === 'private' ? 4096 : 0);
}
function propDefaultValue(info, isStatic) {
  if (!info.hasDef) return null;
  if (isStatic) return info.defE(scopeFrame(info.cls));
  return info.defE(scopeFrame(info.cls));
}
function propHasDefault(p) {
  if (p.dyn) return false;
  if (p.info.decl && p.info.decl.promoted) return false;
  return !!p.info.hasDef || !p.info.type;
}
const PROP_OPS = {
  getName: (r) => r.name,
  getValue(r, obj) {
    if (r.isStatic) return staticValue(r.info);
    if (!(obj instanceof PHPObject)) throwError('TypeError', 'ReflectionProperty::getValue(): Argument #1 ($object) must be provided for instance properties');
    if (!r.dyn && !obj.cls.ancestors.has(r.cls.lname)) reflErr('Given object is not an instance of the class this property was declared in');
    return readProp(obj, r.name, scopeFrame(r.cls));
  },
  setValue(r, objOrValue, ...rest) {
    if (r.isStatic) {
      if (!rest.length) deprecated('Calling ReflectionProperty::setValue() with a single argument is deprecated');
      lookupStaticProp(r.info.cls, r.name);
      r.info.ref.v = rest.length ? rest[0] : objOrValue;
      return null;
    }
    if (!rest.length) throwError('ArgumentCountError', 'ReflectionProperty::setValue() expects exactly 2 arguments, 1 given');
    if (!(objOrValue instanceof PHPObject)) throwError('TypeError', `ReflectionProperty::setValue(): Argument #1 ($objectOrValue) must be of type object, ${typeOf(objOrValue)} given`);
    writeProp(objOrValue, r.name, rest.length ? rest[0] : null, scopeFrame(r.cls));
    return null;
  },
  isInitialized(r, obj) {
    if (r.isStatic) { const s = lookupStaticProp(r.info.cls, r.name) || r.info; return !s.uninit || s.ref.v !== null; }
    if (!(obj instanceof PHPObject)) throwError('TypeError', 'ReflectionProperty::isInitialized(): Argument #1 ($object) must be provided for instance properties');
    return obj.props.has(r.dyn ? r.name : r.info.key);
  },
  skipLazyInitialization(r, obj) {
    r = lazyPropCheck(r, obj, 'skipLazyInitialization');
    if (obj.lazy !== undefined && obj.lazy.instance === null && obj.lazy.keys.has(r.info.key)) lazySkip(obj, lazyInfo(r, obj));
    return null;
  },
  setRawValueWithoutLazyInitialization(r, obj, v) {
    r = lazyPropCheck(r, obj, 'setRawValueWithoutLazyInitialization');
    while (obj.lazy !== undefined && obj.lazy.instance !== null) obj = obj.lazy.instance; // (initialized proxies)
    const info = lazyInfo(r, obj);
    if (info.readonly && obj.props.has(info.key)) throwError('Error', `Cannot modify readonly property ${obj.cls.name}::$${r.name}`);
    if (info.type !== null) v = coercePropType(info, v, info.cls.name, r.name);
    const slot = obj.props.get(info.key);
    const old = slot instanceof Ref ? slot.v : slot;
    if (slot instanceof Ref) slot.v = v; else obj.props.set(info.key, v);
    lazyRealize(obj, info.key);
    if (old !== v && old instanceof PHPObject) { dropRef(old); gcCheck(old); }
    return null;
  },
  isLazy(r, obj) {
    while (obj.lazy !== undefined && obj.lazy.instance !== null) obj = obj.lazy.instance; // (initialized proxies)
    return !r.dyn && !r.isStatic && obj.lazy !== undefined && obj.lazy.keys.has(r.info.key) && !obj.props.has(r.info.key);
  },
  getMangledName: (r) => (r.dyn ? r.name : r.info.vis === 'protected' ? '\0*\0' + r.name : r.info.key),
  getRawValue(r, obj) {
    r = objProp(r, obj);
    if (r.isStatic) reflErr('May not use getRawValue on static properties');
    if (!r.dyn && !obj.cls.ancestors.has(r.cls.lname)) reflErr('Given object is not an instance of the class this property was declared in');
    return readProp(obj, r.name, rawFrame(r, obj));
  },
  setRawValue(r, obj, v) {
    r = objProp(r, obj);
    if (r.isStatic) reflErr('May not use setRawValue on static properties');
    writeProp(obj, r.name, v, rawFrame(r, obj));
    return null;
  },
  isPrivateSet: (r) => !r.dyn && r.info.setVis === 'private',
  isProtectedSet: (r) => !r.dyn && r.info.setVis === 'protected',
  isDynamic: (r) => !!r.dyn,
  isAbstract: (r) => !r.dyn && !!(r.info.decl && r.info.decl.abstract) || (!r.dyn && !!r.info.hooks && ['get', 'set'].some((k) => r.info.hooks[k] && r.info.hooks[k].abstractHook)),
  isVirtual: (r) => !r.dyn && !!r.info.virtual,
  isFinal: (r) => !r.dyn && !!r.info.final,
  getSettableType(r) {
    if (r.dyn) return null;
    const set = r.info.hooks && r.info.hooks.set;
    if (set && set.params && set.params[0] && set.params[0].type) return typeObj(set.params[0].type);
    if (r.info.virtual && !set) return typeObj({ alts: ['never'], nullable: false }); // (can't be written)
    return typeObj(r.info.type);
  },
  hasHooks: (r) => !r.dyn && !!r.info.hooks,
  getHooks(r) {
    const a = new PHPArray();
    if (!r.dyn && r.info.hooks) for (const k of ['get', 'set']) if (r.info.hooks[k]) a.set(k, hookMethod(r, r.info.hooks[k]));
    return a;
  },
  hasHook: (r, type) => !r.dyn && !!r.info.hooks && !!r.info.hooks[type.props.get('value')],
  getHook: (r, type) => { const h = !r.dyn && r.info.hooks && r.info.hooks[type.props.get('value')]; return h ? hookMethod(r, h) : null; },
  isPublic: (r) => r.dyn || r.info.vis === 'public',
  isPrivate: (r) => !r.dyn && r.info.vis === 'private',
  isProtected: (r) => !r.dyn && r.info.vis === 'protected',
  isStatic: (r) => !!r.isStatic,
  isReadOnly: (r) => !r.dyn && !!r.info.readonly,
  isDefault: (r) => !r.dyn,
  isPromoted: (r) => !r.dyn && !!(r.info.decl && r.info.decl.promoted),
  getModifiers: (r) => propModifiers(r),
  getDeclaringClass: (r) => classObj(r.cls),
  getDocComment: (r) => (!r.dyn && r.info.decl && r.info.decl.doc) || false,
  setAccessible: () => { if (rt.phpVersion >= 80500) deprecated('Method ReflectionProperty::setAccessible() is deprecated since 8.5, as it has no effect'); return null; },
  getType: (r) => (r.dyn ? null : typeObj(r.info.type)),
  hasType: (r) => !r.dyn && !!r.info.type,
  hasDefaultValue: (r) => propHasDefault(r),
  getDefaultValue: (r) => (propHasDefault(r) ? propDefaultValue(r.info, r.isStatic) : null),
  getAttributes: (r, name, flags) => attrList(!r.dyn && r.info.decl && r.info.decl.attrs, ATTR_TARGET.property, r.cls, name, flags, 'ReflectionProperty'),
  __toString: (r) => propToString(r),
};

// ---------------------------------------------------------------- class constants and enum cases
function constModifiers(e) { return VIS_BITS[e.vis] | (e.final ? IS_FINAL : 0); }
const CONST_OPS = {
  getName: (r) => r.name,
  getValue: (r) => classConst(r.cls, r.name),
  isPublic: (r) => r.entry.vis === 'public',
  isPrivate: (r) => r.entry.vis === 'private',
  isProtected: (r) => r.entry.vis === 'protected',
  isFinal: (r) => !!r.entry.final,
  getModifiers: (r) => constModifiers(r.entry),
  getDeclaringClass: (r) => classObj(r.cls),
  getDocComment: (r) => (r.entry.decl && r.entry.decl.doc) || false,
  getAttributes: (r, name, flags) => attrList(r.entry.decl && r.entry.decl.attrs, ATTR_TARGET['class constant'], r.cls, name, flags, 'ReflectionClassConstant'),
  isEnumCase: (r) => !!r.entry.case,
  hasType: (r) => !!(r.entry.decl && r.entry.decl.type),
  getType: (r) => typeObj(r.entry.decl && r.entry.decl.type),
  __toString: (r) => constToString(r),
  // ReflectionEnumUnitCase / ReflectionEnumBackedCase
  getEnum: (r) => mk('ReflectionEnum', { k: 'class', cls: r.cls, obj: null }, { name: r.cls.name }),
  getBackingValue: (r) => classConst(r.cls, r.name).props.get('value'),
};

// ---------------------------------------------------------------- __toString() (simplified)
function exportValue(v) {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof PHPArray) return '[' + v.entries().map(([k, x]) => (v.isList && v.isList() ? '' : exportValue(k) + ' => ') + exportValue(x)).join(', ') + ']';
  if (v instanceof PHPObject) return 'Object';
  return toStr(v);
}
// a default value as PHP shows it: constant expressions keep constant names, the rest is folded
function exprSource(n, scope) {
  switch (n.k) {
    case 'Lit': return exportValue(n.v);
    case 'Const': return ['true', 'false', 'null'].includes(lc(n.name)) ? exportValue(cExpr(n)(scopeFrame(scope))) : n.name;
    case 'CConst': return `${n.cls}::${n.name}`;
    case 'ClassName': return n.cls === 'self' && scope && !scope.isTrait ? `'${scope.name}'` : `${n.cls}::class`;
    case 'Arr': return '[' + n.items.map((it) => (it.key ? exprSource(it.key, scope) + ' => ' : '') + exprSource(it.v, scope)).join(', ') + ']';
    case 'New': return `new \\${typeof n.cls === 'string' ? n.cls : '?'}()`;
    case 'Bin': {
      const a = exprSource(n.a, scope), b = exprSource(n.b, scope);
      if (n.a.k === 'Lit' && n.b.k === 'Lit') return exportValue(cExpr(n)(scopeFrame(scope)));
      return `${a} ${n.op} ${b}`;
    }
    case 'Neg': return n.e.k === 'Lit' ? exportValue(cExpr(n)(scopeFrame(scope))) : '-' + exprSource(n.e, scope);
  }
  return exportValue(cExpr(n)(scopeFrame(scope)));
}
function constDisplay(v) {
  if (v === null) return '';
  if (v instanceof PHPArray) return 'Array';
  if (v instanceof PHPObject) return 'Object';
  return toStr(v);
}
function paramToString(r) {
  const p = reflParam(r);
  const opt = r.i >= requiredCount(r.fr.fn, r.fr);
  let s = `Parameter #${r.i} [ <${opt ? 'optional' : 'required'}> `;
  if (p.type) s += typeStr(p.type, null, true) + ' ';
  s += (p.byRef ? '&' : '') + (p.variadic ? '...' : '') + '$' + p.name;
  if (opt && !p.variadic && paramDefaultAvailable(r)) s += ' = ' + (p.rawDef ? p.rawDef : p.defNode ? exprSource(p.defNode, fnScope(r.fr)) : exportValue(p.nativeDef));
  return s + ' ]';
}
function fnToString(r) {
  const fn = r.fn, internal = isInternalFn(fn);
  const kind = r.k === 'method' ? 'Method' : r.closure && fn.isClosure ? 'Closure' : 'Function';
  let s = `${kind} [ <${internal ? (r.k === 'method' ? 'internal:' + classExtension(r.m.cls) : 'internal') : 'user'}${r.k === 'method' && r.m.cls !== r.via ? `, inherits ${r.m.cls.name}` : ''}${r.k === 'method' && lc(r.m.name) === '__construct' ? ', ctor' : ''}> `;
  if (r.k === 'method') s += [r.m.abstract ? 'abstract' : '', r.m.final ? 'final' : '', r.m.static ? 'static' : '', r.m.vis].filter(Boolean).join(' ') + ' method ';
  else s += 'function ';
  s += FN_OPS.getName(r) + ' ] {\n';
  if (!internal) s += `  @@ ${fn.file} ${fn.line} - ${fn.decl.endLine || fn.line}\n`;
  const ps = reflParams(fn, r);
  if (ps.length) {
    s += `\n  - Parameters [${ps.length}] {\n`;
    ps.forEach((p, i) => { s += '    ' + paramToString({ k: 'param', fr: r, i }) + '\n'; });
    s += '  }\n';
  }
  const ai = internalArgs(r);
  if (ai ? ai.ret : fn.ret) s += `  - ${ai && ai.tentative ? 'Tentative return' : 'Return'} [ ${typeStr(ai ? ai.ret : fn.ret, null, true)} ]\n`;
  return s + '}\n';
}
function propToString(r) {
  if (r.dyn) return `Property [ <dynamic> public $${r.name} ]\n`;
  const i = r.info, d = i.decl || {};
  const mods = [d.abstract ? 'abstract' : '', i.final ? 'final' : '', i.vis, i.setVis ? i.setVis + '(set)' : '', r.isStatic ? 'static' : '', i.readonly ? 'readonly' : '', i.virtual ? 'virtual' : ''];
  let s = `Property [ ${mods.filter(Boolean).join(' ')} ${i.type ? typeStr(i.type, null, true) + ' ' : ''}$${r.name}`;
  if (i.hasDef) s += ' = ' + (!r.isStatic && i.evaluated ? fmtDefault(i.val) : d.def ? exprSource(d.def, i.cls) : 'NULL');
  else if (!i.type && !i.virtual) s += ' = NULL';
  if (i.hooks) s += ' {' + ['get', 'set'].map((k) => (i.hooks[k] ? (i.hooks[k].decl && i.hooks[k].decl.final ? ' final ' : ' ') + k + ';' : '')).join('') + ' }';
  return s + ' ]\n';
}
// an evaluated default value as ReflectionProperty::__toString() shows it (format_default_value)
function fmtDefault(v) {
  if (v instanceof PHPObject) return v.cls.isEnum ? `${v.cls.name}::${v.props.get('name')}` : `object(${v.cls.name})`;
  if (v instanceof PHPArray) return '[' + v.entries().map(([k, x]) => (v.isList && v.isList() ? '' : exportValue(k) + ' => ') + fmtDefault(x)).join(', ') + ']';
  return exportValue(v);
}
function constToString(r) {
  const v = classConst(r.cls, r.name);
  const type = r.entry.decl && r.entry.decl.type ? typeStr(r.entry.decl.type, null, true) : typeName(v);
  return `Constant [ ${r.entry.final ? 'final ' : ''}${r.entry.vis} ${type} ${r.name} ] { ${constDisplay(v)} }\n`;
}
function typeName(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (v instanceof Flt) return 'float';
  if (v instanceof PHPArray) return 'array';
  if (v instanceof PHPObject) return 'object';
  return 'int';
}
function classToString(r) {
  const c = r.cls;
  const kind = c.isInterface ? 'Interface' : c.isTrait ? 'Trait' : c.isEnum ? 'Enum' : 'Class';
  const mods = [c.abstract ? 'abstract' : '', c.final || c.isEnum ? 'final' : '', c.readonly ? 'readonly' : ''].filter(Boolean).join(' ');
  let s = `${r.obj ? 'Object of class' : kind === 'Enum' ? 'Class' : kind} [ <${isUserClass(c) ? 'user' : 'internal:' + classExtension(c)}> ${mods}${mods ? ' ' : ''}${c.isInterface ? 'interface' : c.isTrait ? 'trait' : 'class'} ${c.name}`;
  if (c.parent) s += ` extends ${c.parent.name}`;
  const ifs = interfaceOrder(c);
  if (ifs.length) s += ` ${c.isInterface ? 'extends' : 'implements'} ${ifs.map((i) => i.name).join(', ')}`;
  s += ' ] {\n';
  if (isUserClass(c)) s += `  @@ ${c.decl.file} ${c.decl.startLine || c.decl.l}-${c.decl.endLine}\n`;
  const consts = constOrder(c);
  s += `\n  - Constants [${consts.length}] {\n`;
  for (const [n, e] of consts) s += '    ' + constToString({ cls: e.cls, name: n, entry: e });
  s += '  }\n';
  const props = propOrder(c);
  const sprops = props.filter((p) => p.isStatic), iprops = props.filter((p) => !p.isStatic);
  s += `\n  - Static properties [${sprops.length}] {\n`;
  for (const p of sprops) s += '    ' + propToString({ cls: p.info.cls, name: p.name, info: p.info, isStatic: true });
  s += '  }\n';
  const ms = methodOrder(c);
  const sms = ms.filter((m) => m.static), ims = ms.filter((m) => !m.static);
  s += `\n  - Static methods [${sms.length}] {\n`;
  for (const m of sms) s += fnToString({ k: 'method', fn: m.fn, m, cls: m.cls, via: c }).replace(/^/gm, '    ').replace(/ +$/gm, '') + '\n';
  s += '  }\n';
  s += `\n  - Properties [${iprops.length}] {\n`;
  for (const p of iprops) s += '    ' + propToString({ cls: p.info.cls, name: p.name, info: p.info, isStatic: false });
  s += '  }\n';
  s += `\n  - Methods [${ims.length}] {\n`;
  for (const m of ims) s += fnToString({ k: 'method', fn: m.fn, m, cls: m.cls, via: c }).replace(/^/gm, '    ').replace(/ +$/gm, '') + '\n';
  s += '  }\n}\n';
  return s;
}

// ---------------------------------------------------------------- entry points
// ---------------------------------------------------------------- global constants (PHP 8.4)
// the extension an internal constant belongs to
function constExtension(name) {
  if (/^(E_|PHP_|ZEND_|DEFAULT_INCLUDE_PATH|PEAR_|TRUE$|FALSE$|NULL$|DEBUG_BACKTRACE_|UPLOAD_ERR_|__COMPILER_HALT_OFFSET__)/.test(name)) return 'Core';
  const m = /^(JSON|PREG|PCRE|DATE|MB|SPL|CAL|CTYPE|HASH|MHASH|FILTER|LIBXML|ZLIB|ICONV|PASSWORD)_/.exec(name);
  if (m) return { JSON: 'json', PREG: 'pcre', PCRE: 'pcre', DATE: 'date', MB: 'mbstring', SPL: 'spl', CAL: 'calendar', CTYPE: 'ctype', HASH: 'hash', MHASH: 'hash', FILTER: 'filter', LIBXML: 'libxml', ZLIB: 'zlib', ICONV: 'iconv', PASSWORD: 'standard' }[m[1]];
  return 'standard';
}
function findConst(name) {
  const n = name[0] === '\\' ? name.slice(1) : name;
  if (rt.consts.has(n)) return n;
  const i = n.lastIndexOf('\\');
  if (i < 0) return null;
  // (the namespace part is case-insensitive)
  const lns = n.slice(0, i).toLowerCase(), short = n.slice(i + 1);
  for (const k of rt.consts.keys()) { const j = k.lastIndexOf('\\'); if (j === i && k.slice(j + 1) === short && k.slice(0, j).toLowerCase() === lns) return k; }
  return null;
}
const RCONST_OPS = {
  getName: (r) => r.name,
  getNamespaceName: (r) => { const i = r.key.lastIndexOf('\\'); return i < 0 ? '' : r.key.slice(0, i); },
  getShortName: (r) => r.key.slice(r.key.lastIndexOf('\\') + 1),
  getValue: (r) => rt.consts.get(r.key),
  isDeprecated: (r) => rt.deprecatedConsts.has(r.key),
  getFileName: (r) => (rt.userConsts.has(r.key) ? rt.userConsts.get(r.key).file : false),
  getExtension: (r) => (rt.userConsts.has(r.key) ? null : extensionObj(constExtension(r.key))),
  getExtensionName: (r) => (rt.userConsts.has(r.key) ? false : constExtension(r.key)),
  getAttributes: (r, name, flags) => attrList(rt.userConsts.has(r.key) ? rt.userConsts.get(r.key).attrs : null, 64, null, name, flags, 'ReflectionConstant'),
  __toString(r) {
    const v = rt.consts.get(r.key), user = rt.userConsts.has(r.key), dep = rt.deprecatedConsts.has(r.key);
    const mods = [user ? '' : 'persistent', dep ? 'deprecated' : ''].filter(Boolean);
    return `Constant [ ${mods.length ? '<' + mods.join(', ') + '> ' : ''}${typeName(v)} ${r.name} ] { ${constDisplay(v)} }\n`;
  },
};

const OPS = { rconst: RCONST_OPS, class: CLASS_OPS, fn: FUNCTION_OPS, method: METHOD_OPS, param: PARAM_OPS, type: TYPE_OPS, prop: PROP_OPS, const: CONST_OPS, attr: ATTR_OPS };

def('__refl', (self, op, ...args) => {
  const r = refl(self);
  const f = OPS[r.k][op];
  if (!f) throwError('Error', `Call to undefined method ${self.cls.name}::${op}()`);
  return php(f(r, ...args));
});

// constructors: set up self.refl and the public $name/$class properties
def('__refl_init', (self, kind, a, b = null) => {
  const set = (r, props) => { self.refl = r; for (const k in props) self.props.set(k, props[k]); };
  switch (kind) {
    case 'ReflectionClass': case 'ReflectionObject': case 'ReflectionEnum': {
      const cls = a instanceof PHPObject ? a.cls : (() => { const n = strip(toStr(a)); const c = lookupClass(n, true); if (!c) throwError('ReflectionException', `Class "${n}" does not exist`, -1); return c; })();
      if (kind === 'ReflectionEnum' && !cls.isEnum) reflErr(`Class "${cls.name}" is not an enum`);
      set({ k: 'class', cls, obj: kind === 'ReflectionObject' ? a : null }, { name: cls.name });
      return null;
    }
    case 'ReflectionFunction': {
      if (a instanceof PHPObject && a.cls === closureClass) { set({ k: 'fn', fn: a.fn, closure: a }, { name: fnName(a.fn) }); return null; }
      const n = strip(toStr(a));
      const fn = rt.fns.get(lc(n)) || lazyFn(lc(n));
      if (!fn || isInternalName({ decl: { file: fn.file } }, n)) reflErr(`Function ${n}() does not exist`);
      set({ k: 'fn', fn, closure: null }, { name: fn.name });
      return null;
    }
    case 'ReflectionMethod': {
      let cls, name;
      if (b === null) {
        if (typeof a !== 'string' || !a.includes('::')) throwError('ReflectionException', 'ReflectionMethod::__construct(): Argument #1 ($objectOrMethod) must be a valid method name');
        const i = a.indexOf('::');
        cls = resolveClassArg(a.slice(0, i)); name = a.slice(i + 2);
      } else { cls = resolveClassArg(a); name = toStr(b); }
      const m = reflFindMethod(cls, name);
      if (!m) reflErr(`Method ${cls.name}::${name}() does not exist`);
      set({ k: 'method', fn: m.fn, m, cls: m.cls, via: cls }, { name: m.name, class: m.cls.name });
      return null;
    }
    case 'ReflectionProperty': {
      const cls = resolveClassArg(a);
      const name = toStr(b);
      const p = reflFindProp({ cls, obj: a instanceof PHPObject ? a : null }, name);
      if (!p) reflErr(`Property ${cls.name}::$${name} does not exist`);
      set(p, { name, class: p.cls.name });
      return null;
    }
    case 'ReflectionConstant': {
      const name = toStr(a), key = findConst(name);
      if (key === null) reflErr(`Constant "${name}" does not exist`);
      set({ k: 'rconst', name, key }, { name });
      return null;
    }
    case 'ReflectionClassConstant': case 'ReflectionEnumUnitCase': case 'ReflectionEnumBackedCase': {
      const cls = resolveClassArg(a);
      const name = toStr(b);
      const e = cls.consts.get(name);
      if (!e || (e.vis === 'private' && e.cls !== cls)) reflErr(`Constant ${cls.name}::${name} does not exist`);
      if (kind !== 'ReflectionClassConstant' && !e.case) reflErr(`Constant ${cls.name}::${name} is not a case`);
      if (kind === 'ReflectionEnumBackedCase' && !cls.enumBacked) reflErr(`Enum case ${cls.name}::${name} is not a backed case`);
      set({ k: 'const', cls: e.cls, name, entry: e }, { name, class: e.cls.name });
      return null;
    }
    case 'ReflectionParameter': {
      let fr;
      if (a instanceof PHPObject && a.cls === closureClass) fr = { k: 'fn', fn: a.fn, closure: a };
      else if (a instanceof PHPArray) {
        const [c, mname] = a.values();
        const cls = resolveClassArg(c);
        const m = reflFindMethod(cls, toStr(mname));
        if (!m) reflErr(`Method ${cls.name}::${toStr(mname)}() does not exist`);
        fr = { k: 'method', fn: m.fn, m, cls: m.cls, via: cls };
      } else if (a instanceof PHPObject) {
        const m = reflFindMethod(a.cls, '__invoke');
        if (!m) reflErr('Method ' + a.cls.name + '::__invoke() does not exist');
        fr = { k: 'method', fn: m.fn, m, cls: m.cls, via: a.cls };
      } else {
        if (typeof a !== 'string') throwError('TypeError', `ReflectionParameter::__construct(): Argument #1 ($function) must be a string, an array(class, method), or a callable object, ${typeOf(a)} given`);
        const n = strip(a);
        const fn = rt.fns.get(lc(n)) || lazyFn(lc(n));
        if (!fn) reflErr(`Function ${n}() does not exist`);
        fr = { k: 'fn', fn, closure: null };
      }
      const ps = reflParams(fr.fn, fr);
      let i;
      if (typeof b === 'number') { i = b; if (i < 0 || i >= ps.length) reflErr('The parameter specified by its offset could not be found'); }
      else { i = ps.findIndex((p) => p.name === toStr(b)); if (i < 0) reflErr('The parameter specified by its name could not be found'); }
      set({ k: 'param', fr, i }, { name: ps[i].name });
      return null;
    }
  }
  throwError('Error', `Unknown reflection kind ${kind}`);
});

const EXTENSIONS = ['Core', 'date', 'json', 'pcre', 'Reflection', 'SPL', 'standard', 'mbstring', 'ctype', 'hash', 'random', 'filter'];
def('__refl_ext_init', (self, name) => {
  const ext = EXTENSIONS.find((e) => lc(e) === lc(name));
  if (!ext) reflErr(`Extension "${name}" does not exist`);
  self.refl = { k: 'ext', name: ext };
  self.props.set('name', ext);
  return null;
});

// used by #[\Override] checks and Attribute validation elsewhere
export function hasAttribute(attrs, name) { return !!attrs && attrs.some((a) => lc(strip(a.name)) === name); }
