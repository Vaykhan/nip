// User function calls: frames, parameter binding, type checks and coercion, returns.

import {
  cp, FatalSig, Flt, fmtRepr, isInt, mkf, NOREF, normKey, numericStr, objHandles, PHPArray, PHPObject, Ref, ThrowSig } from '../values.js';
import { floatToInt, toBool, toInt, toStr, typeOf, valueName } from '../convert.js';
import { Frame, hasSuspend, RETURN } from '../compiler/common.js';
import { cExpr } from '../compiler/expr.js';
import { cStmts } from '../compiler/stmt.js';
import { cStmtsG, fiberBody } from '../compiler/generator.js';
import { rt } from './state.js';
import { deprecated, PRELUDE_FILE, throwError, warn } from './errors.js';
import { findMethod, isCallable } from './callables.js';
import { frameExit, gcAfterCall } from './gc.js';
import { makeGenerator } from './generators.js';

function argsHoldObjects(args) {
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a !== null && typeof a === 'object' && (a instanceof PHPObject || (a instanceof Ref && a.v instanceof PHPObject))) return true; }
  return false;
}
export function fnDisplayName(fn) {
  if (!fn) return '';
  if (fn.isMethod && fn.cls) return fn.cls.name + '::' + fn.name;
  return fn.name;
}

export function compileFunction(decl, opts = {}) {
  const params = decl.params.map((p) => {
    let type = p.type;
    if (type && p.def && p.def.k === 'Lit' && p.def.v === null && !type.nullable) type = { alts: type.alts, nullable: true };
    return { name: p.name, byRef: p.byRef, variadic: p.variadic, type, promote: p.promote, readonly: p.readonly, def: p.def ? cExpr(p.def) : null, defNode: p.def };
  });
  const refs = params.map((p) => p.byRef);
  const vi = params.findIndex((p) => p.variadic);
  const fn = {
    name: decl.name, decl, params, byRef: decl.byRef, ret: decl.ret, isGen: decl.isGen,
    isCtor: !!opts.method && decl.name.toLowerCase() === '__construct', // see frameExit()
    file: decl.file, line: decl.l, strict: decl.strict,
    refs: refs.some(Boolean) ? refs : null, refRest: vi >= 0 && params[vi].byRef ? vi : null,
    body: null, statics: null, isMethod: !!opts.method, cls: opts.cls || null, isClosure: decl.name === '{closure}',
    required: params.reduce((r, p, i) => (!p.def && !p.variadic ? i + 1 : r), 0), // optional params before required ones are required
    simple: params.every((p) => !p.byRef && !p.variadic && !p.type && !p.promote),
  };
  if (fn.refs && fn.refRest !== null) fn.refs = refs.slice(0, vi);
  if (fn.refRest !== null && !fn.refs) fn.refs = [];
  return fn;
}
export let compilingByRef = false;
export function compileBody(fn) {
  const d = fn.decl;
  const saved = compilingByRef;
  compilingByRef = !!d.byRef && !d.isGen; // (in a generator, & means yielding by reference)
  try {
    if (d.isGen) { if (!d._gbody) d._gbody = cStmtsG(d.body || []); fn.genBody = d._gbody; return null; }
    if (!d._body) d._body = cStmts(d.body || []);
    return (fn.body = d._body);
  } finally { compilingByRef = saved; }
}

export function declareFunction(decl) {
  const lname = decl.name.toLowerCase();
  if (rt.fns.has(lname)) {
    const ex = rt.fns.get(lname);
    if (ex.decl === decl) return;
    throw new FatalSig(`Cannot redeclare ${ex.native ? '' : ''}${decl.name}()${ex.native ? '' : ` (previously declared in ${ex.file}:${ex.line})`}`, decl.l, decl.file);
  }
  const fn = compileFunction(decl);
  rt.fns.set(lname, fn);
  rt.userFnNames.add(lname);
}

function throwInCallee(fn, f, cls, msg) {
  const nf = f || new Frame(fn, null, null, null);
  nf.callLine = rt.line; nf.callFile = rt.file;
  const savedLine = rt.line, savedFile = rt.file;
  rt.stack.push(nf);
  rt.line = fn.line; rt.file = fn.file;
  try { throwError(cls, msg); }
  finally { rt.stack.pop(); rt.line = savedLine; rt.file = savedFile; }
}
function argCountError(fn, given, f) {
  const max = fn.params.some((p) => p.variadic) ? Infinity : fn.params.length;
  const word = fn.required === max ? 'exactly' : 'at least';
  // prelude functions stand in for internal ones, which word the error differently
  if (fn.file === PRELUDE_FILE) throwInCallee(fn, f, 'ArgumentCountError', `${fnDisplayName(fn)}() expects ${word} ${fn.required} argument${fn.required === 1 ? '' : 's'}, ${given} given`);
  const top = rt.stack[rt.stack.length - 1];
  // the caller's location is shown for calls from user code (call_user_func() compiles to one)
  const viaBuiltin = top && top.native === true && !/^call_user_func(_array)?$/.test(top.fn.name);
  const where = viaBuiltin ? '' : ` in ${rt.file} on line ${rt.line}`;
  throwInCallee(fn, f, 'ArgumentCountError', `Too few arguments to function ${fnDisplayName(fn)}(), ${given} passed${where} and ${word} ${fn.required} expected`);
}

// a skipped optional parameter before a named argument (filled with its default, see bindParams)
const DEFAULT_ARG = {};
// named arguments are moved to their parameters' positions (as PHP sends them); those of no
// parameter stay named, for a variadic parameter
function placeNamed(fn, f, args) {
  const ps = fn.params, pos = args.slice(), extra = new Map();
  const vi = ps.findIndex((p) => p.variadic);
  let max = pos.length;
  for (const [k, v] of args.named) {
    const idx = ps.findIndex((p) => p.name === k && !p.variadic);
    if (idx < 0) { if (vi >= 0) { extra.set(k, v); continue; } throwError('Error', `Unknown named parameter $${k}`); }
    if (idx < args.length || pos[idx] !== undefined) throwError('Error', `Named parameter $${k} overwrites previous argument`);
    if (ps[idx].byRef && !(v instanceof Ref)) throwError('Error', `${fnDisplayName(fn)}(): Argument #${idx + 1} ($${k}) could not be passed by reference`);
    pos[idx] = v;
    if (idx + 1 > max) max = idx + 1;
  }
  for (let i = args.length; i < max; i++) {
    if (pos[i] !== undefined) continue;
    if (!ps[i].def) throwInCallee(fn, f, 'ArgumentCountError', `${fnDisplayName(fn)}(): Argument #${i + 1} ($${ps[i].name}) not passed`);
    pos[i] = DEFAULT_ARG;
    pos.defaults = true;
  }
  if (extra.size) pos.named = extra;
  return pos;
}
function bindParams(fn, f, args) {
  if (args.named !== undefined) args = placeNamed(fn, f, args);
  const ps = fn.params, np = ps.length, na = args.length;
  const named = args.named;
  if (na > np && fn.file === PRELUDE_FILE && !(np && ps[np - 1].variadic)) {
    // internal functions reject extra arguments
    throwInCallee(fn, f, 'ArgumentCountError', `${fnDisplayName(fn)}() expects ${fn.required === np ? 'exactly' : 'at most'} ${np} argument${np === 1 ? '' : 's'}, ${na} given`);
  }
  if (fn.simple === true && na >= np && named === undefined && args.defaults === undefined) {
    const vars = f.vars;
    for (let i = 0; i < np; i++) {
      let v = args[i];
      if (v instanceof Ref) v = v.v; else if (v instanceof PHPArray) v.cow = true;
      vars[ps[i].name] = new Ref(v);
    }
    return;
  }
  const strict = rt.frame && rt.frame.fn ? rt.frame.fn.strict : rt.mainStrict;
  for (let i = 0; i < np; i++) {
    const p = ps[i];
    if (p.variadic) {
      const rest = new PHPArray();
      for (let j = i; j < na; j++) {
        let a = args[j];
        if (p.byRef) rest.push(a instanceof Ref ? a : new Ref(a));
        else { if (a instanceof Ref) a = a.v; if (p.type) a = coerceParam(fn, p, j, a, strict, f); rest.push(cp(a)); }
      }
      if (named) for (const [k, v] of named) { if (!ps.some((q) => q.name === k && !q.variadic)) rest.set(k, cp(v instanceof Ref ? v.v : v)); }
      f.vars[p.name] = new Ref(rest);
      break;
    }
    let v;
    if (i < na && args[i] !== DEFAULT_ARG) v = args[i];
    else if (p.def) {
      v = p.defNode.kind === 'Lit' ? p.def(f) : evalDefault(fn, f, p);
      if (p.type && v !== null) v = coerceParam(fn, p, i, v, false, f);
      f.vars[p.name] = new Ref(cp(v));
      if (p.promote) promoteParam(f, p, v);
      continue;
    } else argCountError(fn, na, f);
    if (p.byRef) {
      if (!(v instanceof Ref)) v = new Ref(v);
      f.vars[p.name] = v;
      if (p.promote) promoteParam(f, p, v.v);
      continue;
    }
    if (v instanceof Ref) v = v.v;
    if (p.type !== null && p.type !== undefined) v = coerceParam(fn, p, i, v, strict, f);
    if (v instanceof PHPArray) v.cow = true;
    f.vars[p.name] = new Ref(v);
    if (p.promote) promoteParam(f, p, v);
  }
  // func_get_args() sees the defaults of the parameters named arguments skipped
  for (let i = 0; i < na; i++) if (args[i] === DEFAULT_ARG) args[i] = f.vars[ps[i].name].v;
  return args;
}
// a default that isn't a literal is evaluated in the callee: errors show it in the trace, at the
// default's line
function evalDefault(fn, f, p) {
  const savedLine = rt.line, savedFile = rt.file;
  f.callLine = savedLine; f.callFile = savedFile;
  rt.stack.push(f);
  rt.file = fn.file; if (p.defNode.l) rt.line = p.defNode.l;
  try { return p.def(f); }
  finally { rt.stack.pop(); rt.line = savedLine; rt.file = savedFile; }
}
function promoteParam(f, p, v) {
  const obj = f.this;
  if (!obj) return;
  const info = obj.cls.props.get(p.name);
  obj.props.set(info ? info.key : p.name, cp(v));
}

export const FAIL = { fail: true };
// Type as PHP prints it (zend_type_to_string): class types in declaration order, then builtin
// types in a fixed order, then null ("?T" for a single type). In errors, `iterable` is shown as
// Traversable|array; Reflection keeps it (keepIterable). With a class scope, self/parent are
// resolved to class names (error messages); without one they stay as written (Reflection).
const BUILTIN_TYPE_ORDER = ['static', 'callable', 'object', 'array', 'string', 'int', 'float', 'bool', 'false', 'true', 'void', 'never'];
// the members of a union type in PHP's order: class names (and intersections, as arrays), then
// builtins; `iterable` stays itself when keepIterable, else becomes Traversable|array
export function typeParts(t, scope, keepIterable) {
  const names = [], builtins = new Set();
  let iterable = false;
  for (const a of t.alts) {
    if (typeof a === 'object') names.push(a.inter);
    else if (a === 'iterable') { if (keepIterable) builtins.add('iterable'); else { iterable = true; builtins.add('array'); } }
    else if (BUILTIN_TYPE_ORDER.includes(a) || a === 'mixed') builtins.add(a);
    else if (scope && a === 'self') names.push(scope.name);
    else if (scope && a === 'parent' && scope.parent) names.push(scope.parent.name);
    else names.push(a);
  }
  if (iterable) names.push('Traversable');
  const order = keepIterable ? ['iterable', ...BUILTIN_TYPE_ORDER] : BUILTIN_TYPE_ORDER;
  return names.concat(order.filter((b) => builtins.has(b) && !((b === 'false' || b === 'true') && builtins.has('bool'))));
}
export function typeStr(t, scope, keepIterable) {
  const alts = t.alts;
  if (alts.length === 1 && typeof alts[0] === 'object' && !t.nullable) return alts[0].inter.join('&');
  if (alts.includes('mixed')) return 'mixed';
  const parts = typeParts(t, scope, keepIterable).map((p) => (typeof p === 'string' ? p : '(' + p.join('&') + ')'));
  let str = parts.join('|');
  if (t.nullable) str = str && parts.length === 1 && !str.includes('&') ? '?' + str : (str ? str + '|null' : 'null');
  return str;
}
function matchType(alt, v, ctx) {
  switch (alt) {
    case 'mixed': return true;
    case 'int': return typeof v === 'number' || typeof v === 'bigint';
    case 'float': return v instanceof Flt;
    case 'string': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
    case 'true': return v === true;
    case 'false': return v === false;
    case 'array': return v instanceof PHPArray;
    case 'object': return v instanceof PHPObject;
    case 'iterable': return v instanceof PHPArray || (v instanceof PHPObject && v.cls.ancestors.has('traversable'));
    case 'callable': return isCallable(v);
    case 'null': case 'void': return v === null || v === undefined;
    case 'never': return false;
    case 'self': return v instanceof PHPObject && !!ctx && !!ctx.cls && v.cls.ancestors.has(ctx.cls.lname);
    case 'static': return v instanceof PHPObject && !!ctx && !!(ctx.sc || ctx.cls) && v.cls.ancestors.has((ctx.sc || ctx.cls).lname);
    case 'parent': return v instanceof PHPObject && !!ctx && !!ctx.cls && !!ctx.cls.parent && v.cls.ancestors.has(ctx.cls.parent.lname);
  }
  if (typeof alt === 'object') return alt.inter.every((a) => matchType(a, v, ctx));
  if (!(v instanceof PHPObject)) return false;
  return v.cls.ancestors.has(alt.toLowerCase());
}
export function coerceType(type, v, strict, ctx) {
  if (v === null || v === undefined) {
    if (type.nullable) return null;
    for (const a of type.alts) if (a === 'mixed' || a === 'null' || a === 'void') return null;
    return FAIL;
  }
  const alts = type.alts;
  for (let i = 0; i < alts.length; i++) if (matchType(alts[i], v, ctx)) return v;
  const hasInt = alts.includes('int'), hasFloat = alts.includes('float'), hasStr = alts.includes('string');
  const hasBool = alts.includes('bool') || (alts.includes('true') && toBool(v)) || (alts.includes('false') && !toBool(v));
  if (strict) {
    if (isInt(v) && hasFloat) return mkf(Number(v));
    return FAIL;
  }
  if (isInt(v)) {
    if (hasFloat) return mkf(Number(v));
    if (hasStr) return toStr(v);
    if (hasBool) return toBool(v);
    return FAIL;
  }
  if (v instanceof Flt) {
    if (hasInt && isFinite(v.v)) {
      if (!Number.isInteger(v.v)) { if (!hasStr) { deprecated(`Implicit conversion from float ${fmtRepr(v.v)} to int loses precision`); return floatToInt(v.v); } }
      else return floatToInt(v.v);
    }
    if (hasStr) return toStr(v);
    if (hasBool) return toBool(v);
    return FAIL;
  }
  if (typeof v === 'string') {
    const num = numericStr(v);
    if (num !== null) {
      if (hasInt && !(num instanceof Flt)) return num;
      if (hasFloat) return num instanceof Flt ? num : mkf(Number(num));
      if (hasInt && num instanceof Flt && isFinite(num.v)) {
        if (Number.isInteger(num.v)) return floatToInt(num.v);
        deprecated(`Implicit conversion from float-string "${v}" to int loses precision`);
        return floatToInt(num.v);
      }
    }
    if (hasBool) return toBool(v);
    return FAIL;
  }
  if (typeof v === 'boolean') {
    if (hasInt) return v ? 1 : 0;
    if (hasFloat) return mkf(v ? 1 : 0);
    if (hasStr) return v ? '1' : '';
    return FAIL;
  }
  if (v instanceof PHPObject && hasStr && findMethod(v.cls, '__tostring')) return toStr(v);
  return FAIL;
}
// internal functions (and the prelude functions standing in for them) accept null for scalar
// parameters in coercive mode, with a deprecation (PHP 8.1)
const NULL_TO_SCALAR = { string: '', int: 0, float: null, bool: false };
function internalNullArg(fn, p, i) {
  const alt = p.type.alts.find((a) => a in NULL_TO_SCALAR);
  if (alt === undefined || p.type.alts.some((a) => typeof a !== 'string' || !(a in NULL_TO_SCALAR))) return undefined;
  deprecated(`${fnDisplayName(fn)}(): Passing null to parameter #${i + 1} ($${p.name}) of type ${typeStr(p.type, fn.cls)} is deprecated`);
  return alt === 'float' ? mkf(0) : NULL_TO_SCALAR[alt];
}
function coerceParam(fn, p, i, v, strict, f) {
  if (v === null && !strict && fn.file === PRELUDE_FILE && !p.type.nullable) { const d = internalNullArg(fn, p, i); if (d !== undefined) return d; }
  const r = coerceType(p.type, v, strict, { cls: fn.cls, sc: f ? f.sc : (rt.frame ? rt.frame.sc : null) });
  if (r === FAIL) {
    const top = rt.stack[rt.stack.length - 1];
    const where = (top && top.native === true) || fn.file === PRELUDE_FILE ? '' : `, called in ${rt.file} on line ${rt.line}`;
    // (variadic arguments have no parameter name)
    throwInCallee(fn, f, 'TypeError', `${fnDisplayName(fn)}(): Argument #${i + 1}${p.variadic ? '' : ` ($${p.name})`} must be of type ${typeStr(p.type, fn.cls)}, ${valueName(v)} given${where}`);
  }
  return r;
}
function checkReturn(fn, v, f, none) {
  const t = fn.ret;
  if (t.alts.length === 1) {
    const a = t.alts[0];
    if (a === 'void' || a === 'mixed') return v;
    if (a === 'never') throwError('TypeError', `${fnDisplayName(fn)}(): never-returning function must not implicitly return`);
  }
  const r = coerceType(t, v, fn.strict, { cls: fn.cls, sc: f.sc });
  if (r === FAIL) {
    // static reads as the called class
    const shown = t.alts.includes('static') && (f.sc || fn.cls) ? { ...t, alts: t.alts.map((a) => (a === 'static' ? (f.sc || fn.cls).name : a)) } : t;
    throwError('TypeError', `${fnDisplayName(fn)}(): Return value must be of type ${typeStr(shown, fn.cls)}, ${none ? 'none' : valueName(v === undefined ? null : v)} returned`);
  }
  return r;
}
export function coercePropType(info, v, clsName, name) {
  const r = coerceType(info.type, v, rt.frame && rt.frame.fn ? rt.frame.fn.strict : rt.mainStrict, { cls: info.cls, sc: info.cls });
  // (self and parent are printed as declared)
  if (r === FAIL) throwError('TypeError', `Cannot assign ${valueName(v)} to property ${clsName}::$${name} of type ${typeStr(info.type, null)}`);
  return r;
}

const MAX_DEPTH = 1000000;
export function callFunction(fn, args, thisObj, cls, sc, closure) {
  if (fn.native !== undefined) {
    if (fn.isMethod) return callNativeMethod(fn, thisObj, args, sc);
    return callNative(fn, args);
  }
  const f = new Frame(fn, thisObj, cls, sc);
  if (closure !== null && closure !== undefined) {
    f.closure = closure;
    if (closure.bound) for (const [k, v] of closure.bound) f.vars[k] = v instanceof Ref ? v : new Ref(cp(v));
  }
  args = bindParams(fn, f, args) || args;
  f.args = args;
  if (fn.isGen) return makeGenerator(fn, f);
  const body = fn.body || compileBody(fn);
  const prevFrame = rt.frame, prevLine = rt.line, prevFile = rt.file;
  if (++rt.depth > MAX_DEPTH) { rt.depth = 0; throw new FatalSig(`Maximum function nesting level of '${MAX_DEPTH}' reached, aborting!`); }
  rt.frame = f; rt.file = fn.file;
  f.callLine = prevLine; f.callFile = prevFile;
  rt.stack.push(f);
  const allocs = objHandles.allocs;
  let r, ret;
  try {
    r = body(f);
    ret = r === RETURN ? f.ret : null;
    // the return type is checked in the callee (errors point at its return statement)
    if (fn.ret !== null && fn.ret !== undefined) {
      if (r !== RETURN && fn.decl && fn.decl.endLine) rt.line = fn.decl.endLine; // falling off the end: the closing brace
      ret = checkReturn(fn, ret, f, r !== RETURN);
    }
  } catch (e) {
    // an exception unwinds the call: its locals go too (not what the exception holds)
    rt.stack.pop(); rt.frame = prevFrame; rt.line = prevLine; rt.file = prevFile; rt.depth--;
    if (e instanceof ThrowSig) { frameExit(f.vars, e.obj, fn.isCtor ? thisObj : null); if (f.ret !== null && typeof f.ret === 'object') frameExit([f.ret], e.obj); }
    throw e;
  }
  rt.stack.pop(); rt.frame = prevFrame; rt.line = prevLine; rt.file = prevFile; rt.depth--;
  if (f.retRef) rt.lastRetRef = f.retRef; else if (fn.byRef) rt.lastRetRef = NOREF;
  if (f.destr) gcAfterCall(f, ret);
  // the locals are gone: objects only they held lose their handles (when objects were created
  // during the call or passed to it)
  if (allocs !== objHandles.allocs || argsHoldObjects(args)) frameExit(f.vars, ret, fn.isCtor ? thisObj : null);
  return ret;
}

// fiber mode (see compiler/generator.js): like callFunction(), but runs the callee's fiber-mode
// body, so it can suspend; builtins and generator functions are called normally
export function* callFunctionG(fn, args, thisObj, cls, sc, closure) {
  if (fn.native !== undefined || fn.isGen) return callFunction(fn, args, thisObj, cls, sc, closure);
  // a body without calls can't suspend: run it normally
  if (fn.mayCall === undefined) fn.mayCall = hasSuspend(fn.decl.body || []);
  if (!fn.mayCall) return callFunction(fn, args, thisObj, cls, sc, closure);
  const f = new Frame(fn, thisObj, cls, sc);
  if (closure !== null && closure !== undefined) {
    f.closure = closure;
    if (closure.bound) for (const [k, v] of closure.bound) f.vars[k] = v instanceof Ref ? v : new Ref(cp(v));
  }
  args = bindParams(fn, f, args) || args;
  f.args = args;
  const saved = compilingByRef;
  compilingByRef = !!fn.decl.byRef;
  let body;
  try { body = fiberBody(fn); } finally { compilingByRef = saved; }
  const prevFrame = rt.frame, prevLine = rt.line, prevFile = rt.file;
  if (++rt.depth > MAX_DEPTH) { rt.depth = 0; throw new FatalSig(`Maximum function nesting level of '${MAX_DEPTH}' reached, aborting!`); }
  rt.frame = f; rt.file = fn.file;
  f.callLine = prevLine; f.callFile = prevFile;
  rt.stack.push(f);
  let r;
  try { r = yield* body(f); }
  finally { rt.stack.pop(); rt.frame = prevFrame; rt.line = prevLine; rt.file = prevFile; rt.depth--; }
  const ret = r === RETURN ? f.ret : null;
  if (f.retRef) rt.lastRetRef = f.retRef; else if (fn.byRef) rt.lastRetRef = NOREF;
  if (f.destr) gcAfterCall(f, ret);
  if (fn.ret !== null && fn.ret !== undefined) return checkReturn(fn, ret, f, r !== RETURN);
  return ret;
}
export function callNative(fn, args) {
  if (args.length < fn.min) {
    if (args.named) args = mapNamedNative(fn, args);
    if (args.length < fn.min) throwError('ArgumentCountError', `${fn.name}() expects ${fn.max === fn.min ? 'exactly' : 'at least'} ${fn.min} argument${fn.min === 1 ? '' : 's'}, ${args.length} given`);
  } else if (args.named) args = mapNamedNative(fn, args);
  if (args.length > fn.max) throwError('ArgumentCountError', `${fn.name}() expects ${fn.max === fn.min ? 'exactly' : 'at most'} ${fn.max} argument${fn.max === 1 ? '' : 's'}, ${args.length} given`);
  const prev = rt.nativeName, prevArgs = rt.nativeArgs; rt.nativeName = fn.name; rt.nativeArgs = args;
  const st = rt.stack;
  st.push(new NativeFrame(fn, args));
  let r;
  try {
    r = fn.frame ? fn.native(rt.frame, ...args) : fn.native(...args);
  } finally { rt.nativeName = prev; rt.nativeArgs = prevArgs; st.pop(); }
  if (r === undefined) r = null;
  // objects passed to a builtin and held nowhere else are freed when it returns
  if (argsHoldObjects(args)) frameExit(args, r);
  return r;
}
export class NativeFrame {
  constructor(fn, args) { this.fn = fn; this.args = args; this.callLine = rt.line; this.callFile = rt.file; this.this = null; this.cls = null; this.native = true; }
}
function mapNamedNative(fn, args) {
  const out = args.slice();
  const names = fn.pnames;
  if (!names) throwError('Error', `Named arguments are not supported for ${fn.name}()`);
  for (const [k, v] of args.named) {
    const i = names.indexOf(k);
    if (i < 0) throwError('Error', `Unknown named parameter $${k}`);
    while (out.length < i) out.push(fn.defaults && fn.defaults[out.length] !== undefined ? fn.defaults[out.length] : undefined);
    out[i] = v;
  }
  return out;
}
function callNativeMethod(fn, thisObj, args, sc) {
  const prev = rt.nativeName; rt.nativeName = fn.name;
  const nf = new NativeFrame(fn, args); nf.this = thisObj; nf.cls = fn.cls || (thisObj ? thisObj.cls : sc);
  rt.stack.push(nf);
  try { const r = fn.native(thisObj, args, sc); return r === undefined ? null : r; }
  finally { rt.nativeName = prev; rt.stack.pop(); }
}

// ---------------------------------------------------------------- frame-aware builtins
export const FRAME_FUNCS = {
  compact(f, args) {
    const out = new PHPArray();
    const add = (v) => {
      if (v instanceof Ref) v = v.v;
      if (v instanceof PHPArray) { for (const x of v.values()) add(x); return; }
      const name = toStr(v);
      const r = f.vars[name];
      if (r !== undefined) out.set(normKey(name), cp(r.v));
      else if (name === 'this' && f.this) out.set('this', f.this);
      else warn(`compact(): Undefined variable $${name}`);
    };
    args.forEach(add);
    return out;
  },
  extract(f, args) {
    let a = args[0]; if (a instanceof Ref) a = a.v;
    if (!(a instanceof PHPArray)) throwError('TypeError', `extract(): Argument #1 ($array) must be of type array, ${typeOf(a)} given`);
    const flags = args.length > 1 ? toInt(args[1]) : 0;
    const prefix = args.length > 2 ? toStr(args[2]) : '';
    let n = 0;
    for (const [k, v] of a.entries()) {
      let name = String(k);
      const exists = f.vars[name] !== undefined;
      if (flags === 1 && exists) continue; // EXTR_SKIP
      if (flags === 2 && exists) name = prefix + '_' + name; // EXTR_PREFIX_SAME
      if (flags === 3) name = prefix + '_' + name; // EXTR_PREFIX_ALL
      if (!/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/.test(name) || name === 'this') continue;
      const r = f.vars[name];
      if (r) r.v = cp(v); else f.vars[name] = new Ref(cp(v));
      n++;
    }
    return n;
  },
  get_defined_vars(f) {
    const out = new PHPArray();
    for (const k of Object.keys(f.vars)) out.set(normKey(k), cp(f.vars[k].v));
    return out;
  },
  func_get_args(f) {
    if (!f.fn) throwError('Error', 'func_get_args() cannot be called from the global scope');
    const out = new PHPArray();
    const n = f.args.length;
    for (let i = 0; i < n; i++) {
      const p = f.fn.params[i];
      if (p && !p.variadic && f.vars[p.name]) out.push(cp(f.vars[p.name].v));
      else { const a = f.args[i]; out.push(cp(a instanceof Ref ? a.v : a)); }
    }
    return out;
  },
  func_num_args(f) { if (!f.fn) throwError('Error', 'func_num_args() must be called from a function context'); return f.args.length; },
  func_get_arg(f, args) {
    if (!f.fn) throwError('Error', 'func_get_arg() cannot be called from the global scope');
    const i = toInt(args[0]);
    if (i < 0) throwError('ValueError', 'func_get_arg(): Argument #1 ($position) must be greater than or equal to 0');
    if (i >= f.args.length) throwError('ValueError', 'func_get_arg(): Argument #1 ($position) must be less than the number of the arguments passed to the currently executed function');
    const p = f.fn.params[i];
    if (p && f.vars[p.name]) return f.vars[p.name].v;
    const a = f.args[i]; return a instanceof Ref ? a.v : (a === undefined ? null : a);
  },
  get_called_class(f) { if (!f.sc) throwError('Error', 'get_called_class() must be called from within a class'); return f.sc.name; },
};
