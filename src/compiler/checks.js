// Compile-time checks: errors PHP reports for a whole file before running any of it.
//
// NIP compiles function bodies lazily, so errors PHP finds while compiling must be looked for
// here, right after parsing, to be reported for code that never runs and before any output.

import { FatalSig, Flt, PHPArray } from '../values.js';
import { cExpr } from './expr.js';
import { Frame } from './common.js';
import { rt } from '../runtime/state.js';
import { typeStr } from '../runtime/functions.js';
import { toBool, valueName } from '../convert.js';
import { deprecated, warn } from '../runtime/errors.js';
import { RESERVED_CLASS_NAMES } from '../parser.js';

// How an expression is used: read, written (assignment target, by-ref argument, ...), unset,
// or passed as an argument whose by-ref-ness is only known at run time.
// ASSIGN: the target itself is assigned ($x = ..., foreach targets, list() items)
const READ = 0, WRITE = 1, UNSET = 2, ARG = 3, ASSIGN = 4;
// zend_is_variable_or_call: what can be written through ($a[0] = 1, f()->x = 1); anything else is
// a temporary value
const VAR_OR_CALL = new Set(['Var', 'VarVar', 'Index', 'Prop', 'SProp', 'Call', 'MCall', 'NullsafeMCall', 'SCall']);
const CONST_EXPR_NODES = new Set(['Lit', 'Bin', 'And', 'Or', 'Xor', 'Not', 'BitNot', 'Neg', 'Plus', 'Ternary', 'Index', 'Arr',
  'Const', 'CConst', 'ClassName', 'Name', 'MagicClass', 'MagicMethod', 'Coalesce', 'New', 'Prop']);
// [argument count (null: any), static, must be public, argument types, return type (false: none
// allowed)]
const MAGIC_SIGS = {
  __construct: [null, false, false, null, false], __destruct: [0, false, false, null, false], __clone: [0, false, false, null, 'void'],
  __get: [1, false, true, ['string'], null], __set: [2, false, true, ['string'], 'void'], __unset: [1, false, true, ['string'], 'void'],
  __isset: [1, false, true, ['string'], 'bool'], __call: [2, false, true, ['string', 'array'], null],
  __callstatic: [2, true, true, ['string', 'array'], null], __tostring: [0, false, true, null, 'string'],
  __debuginfo: [0, false, true, null, '?array'], __serialize: [0, false, true, null, 'array'],
  __unserialize: [1, false, true, ['array'], 'void'], __set_state: [1, true, true, ['array'], 'object'],
  __invoke: [null, false, true, null, null], __sleep: [0, false, true, null, 'array'], __wakeup: [0, false, true, null, 'void'],
};
// the builtin types a declared type allows (complex: it names a class)
const TYPE_BITS = {
  int: ['int'], float: ['float'], string: ['string'], bool: ['true', 'false'], true: ['true'], false: ['false'], array: ['array'],
  object: ['object'], callable: ['callable'], iterable: ['array'], void: ['void'], never: ['never'], null: ['null'], static: ['static'],
  mixed: ['int', 'float', 'string', 'true', 'false', 'array', 'object', 'callable', 'null', 'resource'],
};
function typeBits(t) {
  const bits = new Set();
  let complex = false;
  for (const a of t.alts) {
    const b = typeof a === 'string' ? TYPE_BITS[a.toLowerCase()] : null;
    if (b) b.forEach((x) => bits.add(x)); else complex = true;
    if (a === 'iterable') complex = true;
  }
  if (t.nullable) bits.add('null');
  return { bits, complex };
}
const SPECIAL_BUILTINS = {
  strlen: 1, is_null: 1, is_bool: 1, is_long: 1, is_int: 1, is_integer: 1, is_float: 1, is_double: 1, is_string: 1, is_array: 1,
  is_object: 1, is_resource: 1, is_scalar: 1, boolval: 1, intval: 1, floatval: 1, doubleval: 1, strval: 1, gettype: 1, count: 1,
  sizeof: 1, get_class: [0, 1], get_called_class: 0, func_num_args: 0, func_get_args: 0, array_key_exists: 2,
};
const AUTO_GLOBALS = new Set(['GLOBALS', '_SERVER', '_GET', '_POST', '_COOKIE', '_FILES', '_ENV', '_REQUEST', '_SESSION']);
const isTemp = (n) => !!n && typeof n === 'object' && !Array.isArray(n) && !VAR_OR_CALL.has(n.k);

export function checkProgram(ast, file) {
  const seen = new WeakSet();
  const fail = (msg, n) => { throw new FatalSig(msg, n.l); };
  // deprecations PHP raises while compiling
  const atNode = (raiseFn) => (msg, n) => {
    const prevFile = rt.file, prevLine = rt.line;
    rt.file = file; rt.line = n.l;
    try { raiseFn(msg); } finally { rt.file = prevFile; rt.line = prevLine; }
  };
  const compileDeprecated = atNode(deprecated), compileWarning = atNode(warn);
  for (const w of ast.compileWarnings || []) (w.deprecated ? compileDeprecated : compileWarning)(w.msg, w); // found by the lexer and parser
  // goto: labels and gotos of the current function, and the loops/switches/finally blocks
  // enclosing the statement being visited
  let scope = newScope(), path = [];
  const methods = new WeakSet(); // function nodes that are methods (attribute target "method")
  // the function being checked: null at the top level (which may run inside a class via
  // include), else { cls: enclosing ClassDecl or null, closure }
  let fnCtx = null, curClass = null, curFn = null;
  const knownFns = new Map(); // functions declared earlier in the file (see 'FuncDecl')

  function visit(n, ctx) {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    if (Array.isArray(n)) { for (const x of n) visit(x, ctx); return; }
    seen.add(n);
    if (!n.k && Array.isArray(n.params) && Array.isArray(n.body)) { visitFunction(n); return; }
    if (typeof n.cls === 'string' && CLASS_REF_NODES.has(n.k)) checkClassRef(n.cls, n, fnCtx || (curClass ? { cls: curClass, closure: false } : null));
    // a constant value as the class (zend_compile_class_ref)
    if (n.cls && typeof n.cls === 'object' && CLASS_REF_NODES.has(n.k) && n.k !== 'New' && n.k !== 'Instanceof') {
      const c = n.cls;
      const literal = (c.k === 'Lit' && typeof c.v !== 'string') || c.k === 'Arr' || ((c.k === 'Neg' || c.k === 'Plus') && c.e && c.e.k === 'Lit');
      if (literal) fail('Illegal class name', n);
      if (n.k === 'ClassName' && isConstFoldable(c)) {
        let v; try { v = cExpr(c)(new Frame(null, null, null, null)); } catch (e) { v = undefined; }
        if (v !== undefined && !(v !== null && typeof v === 'object' && !(v instanceof Flt) && !(v instanceof PHPArray))) fail(`Cannot use "::class" on ${valueName(v)}`, n);
      }
    }
    // $o->{0}(): the method name is a constant that isn't a string
    if ((n.k === 'MCall' || n.k === 'SCall' || n.k === 'NullsafeMCall') && n.name && typeof n.name === 'object' && n.name.k === 'Lit' && typeof n.name.v !== 'string') fail('Method name must be a string', n);
    switch (n.k) {
      case 'Lit': return;
      case 'ParentHook': {
        const fn = curFn;
        if (!fnCtx || !fnCtx.cls) fail('Cannot use "parent" when no class scope is active', n);
        if (!fn || !fn.hookProp) fail(`Must not use parent::$${n.prop}::${n.hook}() outside a property hook`, n);
        if (fn.hookProp !== n.prop) fail(`Must not use parent::$${n.prop}::${n.hook}() in a different property ($${fn.hookProp})`, n);
        if (fn.hook !== n.hook) fail(`Must not use parent::$${n.prop}::${n.hook}() in a different property hook (${fn.hook})`, n);
        break;
      }
      case 'And': case 'Or':
        // a constant left side decides it: PHP doesn't compile the right side at all
        if (n.a && n.a.k === 'Lit' && (n.k === 'And') !== toBool(n.a.v)) { visit(n.a, READ); return; }
        break;
      case 'Match': {
        if (n.arms.filter((a) => !a.conds).length > 1) fail('Match expressions may only contain one default arm', n);
        break;
      }
      case 'YieldFrom':
        if (scope.byRef) fail('Cannot use "yield from" inside a by-reference generator', n);
        break;
      case 'Throw': break;
      case 'ClassDecl': {
        if (!n.anon) { const short = n.name.slice(n.name.lastIndexOf('\\') + 1); if (RESERVED_CLASS_NAMES.has(short.toLowerCase())) fail(`Cannot use '${short}' as class name as it is reserved`, n); }
        checkClass(n);
        checkAttrs(n.attrs, T_CLASS, n);
        for (const m of n.methods) {
          checkAttrs(m.fn.attrs, T_METHOD, m); methods.add(m.fn);
          const lm = m.fn.name.toLowerCase();
          if ((lm === '__construct' || lm === '__clone') && rt.phpVersion >= 80500 && hasAttrName(m.fn.attrs, 'nodiscard')) fail(`Method ${n.name}::${m.fn.name} cannot be #[\\NoDiscard]`, m);
        }
        for (const p of n.props) {
          checkAttrs(p.attrs, T_PROPERTY, p); if (p.type) checkType(p.type, p, { cls: n, closure: false }); checkSetVis(n, p, p.vis, p.l);
          if (p.hooks) for (const h of Object.values(p.hooks)) { methods.add(h); checkAttrs(h.attrs, T_METHOD, h); }
        }
        for (const m of n.methods) if (m.fn.name.toLowerCase() === '__construct') for (const p of m.fn.params) if (p.promote) checkSetVis(n, p, p.promote, m.l);
        for (const c of n.consts) {
          checkAttrs(c.attrs, T_CLASS_CONSTANT, c);
          checkConstExpr(c.e, false);
          if (c.type) {
            const bad = c.type.alts.find((a) => typeof a === 'string' && ['callable', 'void', 'never'].includes(a.toLowerCase()));
            if (bad) fail(`Class constant ${n.name}::${c.name} cannot have type ${bad.toLowerCase()}`, c);
            const lit = literalValue(c.e);
            if (lit !== NOT_LITERAL && (lit === null ? !c.type.nullable && !c.type.alts.some((a) => a === 'mixed' || a === 'null') : !validDefault(c.type, lit))) {
              fail(`Cannot use ${literalType(lit)} as value for class constant ${n.name}::${c.name} of type ${typeStr(c.type, null)}`, c);
            }
          }
        }
        for (const c of n.cases) { checkAttrs(c.attrs, T_CLASS_CONSTANT, c); checkConstExpr(c.e, false); }
        for (const p of n.props) {
          checkConstExpr(p.def, false);
          if (p.type && p.hasDef && p.def) {
            const lit = literalValue(p.def), ts = typeStr(p.type, null);
            if (lit === null && !p.type.nullable && !p.type.alts.some((a) => a === 'mixed' || a === 'null')) {
              if (p.type.alts.some((a) => typeof a === 'object')) fail(`Cannot use null as default value for property ${n.name}::$${p.name} of type ${ts}`, p);
              fail(`Default value for property of type ${ts} may not be null. Use the nullable type ?${ts} to allow null default value`, p);
            }
            if (lit !== NOT_LITERAL && lit !== null && !validDefault(p.type, lit)) fail(`Cannot use ${literalType(lit)} as default value for property ${n.name}::$${p.name} of type ${ts}`, p);
          }
        }
        const outer = curClass;
        curClass = n;
        try { for (const key in n) if (key !== 'l') visit(n[key], READ); } finally { curClass = outer; }
        return;
      }
      case 'Index':
        if (n.i === null) {
          if (n.o && n.o.k === 'Var' && n.o.name === 'GLOBALS') fail('Cannot append to $GLOBALS', n);
          if (ctx === READ) fail('Cannot use [] for reading', n);
          if (ctx === UNSET) fail('Cannot use [] for unsetting', n);
        }
        if (ctx !== READ && ctx !== ARG && isTemp(n.o)) fail('Cannot use temporary expression in write context', n);
        visit(n.o, ctx === READ ? READ : ctx === UNSET ? UNSET : WRITE);
        visit(n.i, READ);
        return;
      case 'Var':
        if (ctx === ASSIGN && n.name === 'this') fail('Cannot re-assign $this', n);
        if (ctx === ASSIGN && n.name === 'GLOBALS') fail('$GLOBALS can only be modified using the $GLOBALS[$name] = $value syntax', n);
        if (ctx === UNSET && n.name === 'this') fail('Cannot unset $this', n);
        return;
      case 'Prop':
        if (n.nullsafe && ctx !== READ && ctx !== ARG) fail("Can't use nullsafe operator in write context", n);
        if (ctx !== READ && ctx !== ARG && isTemp(n.o)) fail('Cannot use temporary expression in write context', n);
        visit(n.o, ctx === READ ? READ : WRITE);
        if (typeof n.name === 'object') visit(n.name, READ);
        return;
      case 'Assign': case 'AssignOp':
        ensureWritable(n.t);
        // [&$a] = expr: the value must be something a reference can point into
        if (n.k === 'Assign' && (n.t.k === 'List' || n.t.k === 'Arr') && hasRefItem(n.t)) {
          if (isNullsafeChain(n.e)) fail('Cannot take reference of a nullsafe chain', n);
          if (!VAR_OR_CALL.has(n.e.k)) fail('Cannot assign reference to non referenceable value', n);
        }
        visit(n.t, ASSIGN); visit(n.e, READ); return;
      case 'AssignRef':
        if (n.e && n.e.k === 'Prop' && n.e.nullsafe) fail('Cannot take reference of a nullsafe chain', n);
        if (n.e && n.e.k === 'Var' && n.e.name === 'GLOBALS') fail('Cannot acquire reference to $GLOBALS', n);
        ensureWritable(n.t); visit(n.t, ASSIGN); visit(n.e, WRITE); return;
      case 'PreInc': case 'PreDec': case 'PostInc': case 'PostDec': ensureWritable(n.e); visit(n.e, WRITE); return;
      case 'Unset':
        for (const x of n.list) {
          ensureWritable(x);
          if (x && x.k === 'Var' && x.name === 'GLOBALS') fail('$GLOBALS can only be modified using the $GLOBALS[$name] = $value syntax', x);
        }
        visit(n.list, UNSET); return;
      case 'Arr':
        if (ctx !== ASSIGN) {
          const empty = (n.items || []).indexOf(null);
          // reported at the element before the empty one, which PHP compiled last
          if (empty >= 0) { const prev = n.items.slice(0, empty).reverse().find(Boolean); fail('Cannot use empty array elements in arrays', (prev && prev.v && prev.v.l) ? prev.v : n); }
          break;
        }
      // falls through: [$a, $b] = ... destructuring
      case 'List': {
        if (n.k === 'List' && ctx !== ASSIGN && ctx !== WRITE) fail('Cannot use list() as standalone expression', n);
        const items = (n.items || []).filter(Boolean);
        if (!items.length) fail('Cannot use empty list', n);
        if (items.some((it) => it.key) && items.length < n.items.length) fail('Cannot use empty array entries in keyed array assignment', n);
        if (items.some((it) => it.spread)) fail('Spread operator is not supported in assignments', n);
        if (items.some((it) => it.key) && items.some((it) => !it.key)) fail('Cannot mix keyed and unkeyed array entries in assignments', n);
        for (const it of items) {
          let t = it.v;
          while (t && (t.k === 'Index' || t.k === 'Prop')) t = t.o;
          if (it.v && it.v.k === 'Pipe') fail("Can't use function return value in write context", it.v); // (a pipe is a call)
          if (it.v && it.v.k !== 'Arr' && it.v.k !== 'List' && isTemp(t)) fail('Assignments can only happen to writable values', n);
        }
        for (const it of items) { visit(it.key, READ); visit(it.v, it.byRef ? WRITE : ASSIGN); }
        return;
      }
      case 'Call':
        // with zend.assertions=-1, assert() calls aren't compiled at all
        if (typeof n.f === 'string' && /^\\?assert$/i.test(n.fb || n.f) && (rt.ini.get('zend.assertions') ?? '-1') === '-1') return;
        // builtins compiled to an instruction have a temporary result (zend_separate_if_call_and_write)
        if (ctx !== READ && ctx !== ARG && typeof n.f === 'string' && tmpBuiltin(n)) fail('Cannot use result of built-in function in write context', n);
        visit(n.f, READ); visitArgs(n.args, typeof n.f === 'string' ? builtin(n) || knownFns.get(n.f.replace(/^\\/, '').toLowerCase()) : null, n); return;
      case 'FuncDecl':
        if (n.fn && /\\assert$/i.test(n.fn.name)) fail('Defining a custom assert() function is not allowed, as the function has special semantics', n);
        visit(n.fn, READ);
        // a top-level function is declared once compiled: later calls in the file know its parameters
        if (n.top && n.fn && n.fn.name) {
          const ps = n.fn.params, vi = ps.findIndex((p) => p.variadic);
          knownFns.set(n.fn.name.toLowerCase(), { refs: ps.map((p) => !!p.byRef), refRest: vi >= 0 && ps[vi].byRef ? vi : null });
        }
        return;
      case 'MCall': case 'NullsafeMCall':
        if (n.args === 'fcc' && isNullsafeChain(n)) fail('Cannot combine nullsafe operator with Closure creation', n);
        visit(n.o, READ); if (typeof n.name === 'object') visit(n.name, READ); visitArgs(n.args, null, n); return;
      case 'SCall': case 'New':
        if (n.k === 'New' && n.args === 'fcc') fail('Cannot create Closure for new expression', n);
        visit(n.cls, READ); if (typeof n.name === 'object') visit(n.name, READ); visitArgs(n.args, null, n); return;
      case 'ConstDecl': for (const it of n.items) checkConstExpr(it.e, true); break;
      case 'Global':
        for (const x of n.names) if (x === 'this') fail('Cannot use $this as global variable', n);
        break;
      case 'StaticVar':
        for (const v of n.vars) {
          if (v.name === 'this') fail('Cannot use $this as static variable', n);
          if (!scope.statics) scope.statics = new Set();
          if (scope.statics.has(v.name)) fail(`Duplicate declaration of static variable $${v.name}`, n);
          scope.statics.add(v.name);
        }
        break;
      case 'Label':
        if (scope.labels.has(n.name)) fail(`Label '${n.name}' already defined`, n);
        scope.labels.set(n.name, path.slice());
        return;
      case 'Goto': scope.gotos.push({ n, path: path.slice() }); return;
      case 'Break': case 'Continue': {
        const word = n.k === 'Break' ? 'break' : 'continue', depth = Number(n.n);
        const targets = path.filter((p) => p.kind === 'loop' || p.kind === 'switch').reverse();
        if (!targets.length) fail(`'${word}' not in the 'loop' or 'switch' context`, n);
        if (depth > targets.length) fail(`Cannot '${word}' ${depth} level${depth === 1 ? '' : 's'}`, n);
        const fin = path.findIndex((p) => p.kind === 'finally');
        if (fin >= 0 && path.indexOf(targets[depth - 1]) < fin) fail('jump out of a finally block is disallowed', n);
        if (word === 'continue' && targets[depth - 1].kind === 'switch') {
          const outer = depth < targets.length;
          const msg = depth === 1 ? '"continue" targeting switch is equivalent to "break"' : `"continue ${depth}" targeting switch is equivalent to "break ${depth}"`;
          compileWarning(outer ? `${msg}. Did you mean to use "continue ${depth + 1}"?` : msg, n);
        }
        return;
      }
      case 'Return': {
        const ret = scope.ret && !scope.isGen && scope.ret.raw && scope.ret.raw.length === 1 && !scope.ret.q && typeof scope.ret.raw[0] === 'string' ? scope.ret.raw[0].toLowerCase() : null;
        if (ret === 'void' && n.e) fail(n.e.k === 'Lit' && n.e.v === null ? 'A void function must not return a value (did you mean "return;" instead of "return null;"?)' : 'A void function must not return a value', n);
        if (ret === 'never') fail('A never-returning function must not return', n);
        if (!n.e && scope.ret && !scope.isGen && ret !== 'void') {
          const t = scope.ret;
          const nullOk = t.nullable || t.alts.some((a) => a === 'mixed' || a === 'null');
          fail(`A function with return type must return a value${nullOk ? ' (did you mean "return null;" instead of "return;"?)' : ''}`, n);
        }
        visit(n.e, scope.byRef ? WRITE : READ); return; // function &f() { return $a[]; }
      }
      case 'While': case 'DoWhile': case 'For': case 'Foreach': case 'Switch': {
        if (n.k === 'Foreach' && n.kv && (n.kv.k === 'List' || n.kv.k === 'Arr')) fail('Cannot use list as key element', n);
        const { body, cases, ...rest } = n;
        if (n.k === 'Switch') {
          const defaults = n.cases.filter((c) => !c.test);
          if (defaults.length > 1) fail('Switch statements may only contain one default clause', defaults[1]);
        }
        const ctxOf = (key) => (key === 'kv' || key === 'v' ? ASSIGN : key === 'e' && n.k === 'Foreach' && n.byRef ? WRITE : READ);
        for (const key in rest) if (key !== 'l' && key !== 'k') visit(rest[key], ctxOf(key));
        within(n.k === 'Switch' ? 'switch' : 'loop', () => { visit(body, READ); visit(cases, READ); });
        return;
      }
      case 'Try':
        for (const c of n.catches) if (c.v === 'this') fail('Cannot re-assign $this', c.l ? c : n);
        if (n.fin) scope.hasFinally = true; else scope.hasTryWithoutFinally = true;
        within('try', () => { visit(n.body, READ); visit(n.catches, READ); });
        within('finally', () => visit(n.fin, READ));
        return;
    }
    for (const key in n) if (key !== 'l') visit(n[key], READ);
  }

  // an expression PHP evaluates while compiling (literals and operators on them)
  function isConstFoldable(e) {
    if (!e || typeof e !== 'object') return false;
    if (e.k === 'Lit') return true;
    if (e.k === 'Bin') return isConstFoldable(e.a) && isConstFoldable(e.b);
    if (e.k === 'Neg' || e.k === 'Plus' || e.k === 'Not' || e.k === 'BitNot') return isConstFoldable(e.e);
    return false;
  }
  function hasRefItem(list) { return (list.items || []).some((it) => it && (it.byRef || ((it.v.k === 'List' || it.v.k === 'Arr') && hasRefItem(it.v)))); }
  function isNullsafeChain(e) {
    for (let x = e; x && typeof x === 'object'; x = x.o) if (x.nullsafe || x.k === 'NullsafeMCall') return true;
    return false;
  }
  // zend_ensure_writable_variable: what an assignment, ++/-- or unset() targets
  function ensureWritable(t) {
    if (!t || typeof t !== 'object') return;
    if (t.k === 'Call' || t.k === 'Pipe') fail("Can't use function return value in write context", t);
    if (t.k === 'MCall' || t.k === 'NullsafeMCall' || t.k === 'SCall') fail("Can't use method return value in write context", t);
  }
  // builtins zend_try_compile_special_func compiles to an instruction (with these argument counts)
  function tmpBuiltin(n) {
    if (!Array.isArray(n.args) || n.args.some((a) => a.spread || a.name)) return false;
    if (n.fb && !n.f.startsWith('\\')) return false; // unqualified in a namespace: resolved at run time
    const want = SPECIAL_BUILTINS[n.f.replace(/^\\/, '').toLowerCase()];
    return want !== undefined && (Array.isArray(want) ? want.includes(n.args.length) : want === n.args.length);
  }
  // A builtin known at compile time: PHP checks its by-value arguments as reads.
  function builtin(n) {
    if (n.fb && n.f.includes('\\') && !n.f.startsWith('\\')) return null; // namespaced: resolved at run time
    const fn = rt.fns.get(n.f.replace(/^\\/, '').toLowerCase());
    return fn && fn.native ? fn : null;
  }
  function visitArgs(args, fn, call) {
    if (!Array.isArray(args)) return;
    let unpacked = false, named = false;
    for (const a of args) {
      if (a.spread) { if (named) fail('Cannot use argument unpacking after named arguments', call); unpacked = true; }
      else if (a.name) named = true;
      else if (unpacked) fail('Cannot use positional argument after argument unpacking', call);
      else if (named) fail('Cannot use positional argument after named argument', call);
    }
    args.forEach((a, i) => {
      if (!a) return;
      const e = a.e !== undefined ? a.e : a;
      if (a.spread || a.name) { visit(e, ARG); return; }
      // a builtin's by-reference parameter is a write; for other functions it's known at run time
      if (!fn) visit(e, ARG);
      else visit(e, (fn.refs && fn.refs[i]) || (fn.refRest !== null && i >= fn.refRest) ? WRITE : READ);
    });
  }

  // declaration rules PHP checks when compiling a class
  function checkClass(n) {
    const name = n.anon ? 'class@anonymous' : n.name, kind = n.kind;
    if (kind !== 'class' && kind !== 'enum' && hasAttrName(n.attrs, 'allowdynamicproperties')) fail(`Cannot apply #[AllowDynamicProperties] to ${kind}`, n);
    if (n.flags.readonly && hasAttrName(n.attrs, 'allowdynamicproperties')) fail(`Cannot apply #[AllowDynamicProperties] to readonly class ${name}`, n);
    if (kind === 'interface' && n.traits.length) fail(`Cannot use traits inside of interfaces. ${n.traits[0].names[0]} is used in ${name}`, n.traits[0].l ? n.traits[0] : n);
    if (kind === 'enum' && n.enumType) {
      const bt = n.enumType.raw && n.enumType.raw.length === 1 ? String(n.enumType.raw[0]).toLowerCase() : 'mixed';
      if (bt !== 'int' && bt !== 'string') fail(`Enum backing type must be int or string, ${typeStr(n.enumType, null)} given`, n);
    }
    const consts = new Set();
    for (const c of [...n.consts, ...n.cases].sort((a, b) => a.seq - b.seq)) {
      if (consts.has(c.name)) fail(`Cannot redefine class constant ${name}::${c.name}`, c);
      if (c.name.toLowerCase() === 'class') fail("A class constant must not be called 'class'; it is reserved for class name fetching", c);
      if (c.vis === 'private' && c.final) fail(`Private constant ${name}::${c.name} cannot be final as it is not visible to other classes`, c);
      consts.add(c.name);
      if (kind === 'interface' && c.vis && c.vis !== 'public') fail(`Access type for interface constant ${name}::${c.name} must be public`, c);
    }
    if (kind !== 'enum' && n.cases.length) fail('Case can only be used in enums', n.cases[0]);
    for (const c of n.cases) {
      if (!n.enumType && c.e) fail(`Case ${c.name} of non-backed enum ${name} must not have a value`, c);
      if (n.enumType && !c.e) fail(`Case ${c.name} of backed enum ${name} must have a value`, c);
    }
    const props = new Set();
    const checkProp = (p, l, promoted) => {
      if (props.has(p.name)) fail(`Cannot redeclare ${name}::$${p.name}`, l);
      props.add(p.name);
      if (p.readonly && !p.type) fail(`Readonly property ${name}::$${p.name} must have type`, l);
      if (p.readonly && p.static) fail(`Static property ${name}::$${p.name} cannot be readonly`, l);
      if (p.readonly && p.hasDef) fail(`Readonly property ${name}::$${p.name} cannot have default value`, l);
      if (p.type && !promoted) checkTypeDecl(p.type, 'prop', l, `${name}::$${p.name}`);
    };
    for (const p of n.props) {
      // hooked properties (PHP 8.4)
      if (kind === 'interface' && rt.phpVersion >= 80400) {
        if (!p.hooks) fail('Interfaces may only include hooked properties', p);
        if (p.vis !== 'public') fail('Property in interface cannot be protected or private', p);
        if (p.abstract) fail('Property in interface cannot be explicitly abstract. All interface members are implicitly abstract', p);
      } else if (kind === 'interface') fail('Interfaces may not include properties', p);
      if (p.abstract && !p.hooks) fail('Only hooked properties may be declared abstract', p);
      if (p.final && p.abstract) fail('Cannot use the final modifier on an abstract property', p);
      if (p.final && p.vis === 'private') fail('Property cannot be both final and private', p);
      if (p.final && kind === 'interface') fail('Property in interface cannot be final', p);
      if (p.abstract && p.hooks && !Object.values(p.hooks).some((h) => h.abstract)) fail(`Abstract property ${name}::$${p.name} must specify at least one abstract hook`, p);
      if (p.hooks) {
        if (p.readonly) fail('Hooked properties cannot be readonly', p);
        if (p.static) fail('Cannot declare hooks for static property', p);
        const hs = Object.values(p.hooks);
        for (const h of hs) {
          if (h.abstract && h.final) fail('Property hook cannot be both abstract and final', h);
          if (h.final && p.vis === 'private') fail('Property hook cannot be both final and private', h);
          if (h.abstract && p.vis === 'private') fail('Property hook cannot be both abstract and private', h);
          if (h.hook === 'set' && h.explicitParams && h.params[0] && h.params[0].def) fail(`Parameter $${h.params[0].name} of set hook ${name}::$${p.name} must not have a default value`, h);
          if (h.abstract && kind !== 'interface' && !n.flags.abstract && !p.abstract && kind !== 'trait') fail(`Class ${name} declares abstract property hook ${name}::$${p.name}::${h.hook} and must therefore be declared abstract`, h);
          if (h.hook === 'get' && h.explicitParams) fail(`get hook of property ${name}::$${p.name} must not have a parameter list`, h);
          if (h.hook === 'set' && h.explicitParams && h.params.length !== 1) fail(`set hook of property ${name}::$${p.name} must accept exactly one parameter`, h);
        }
      }
      if (kind === 'enum') fail(`Enum ${name} cannot include properties`, p);
      checkProp(p, p, false);
    }
    const methods = new Set();
    for (const m of n.methods) {
      const fn = m.fn, ln = fn.name.toLowerCase();
      if (methods.has(ln)) fail(`Cannot redeclare ${name}::${fn.name}()`, m);
      methods.add(ln);
      if (kind === 'interface') {
        if (m.vis !== 'public') fail(`Access type for interface method ${name}::${fn.name}() must be public`, m);
        if (m.abstractKw) fail(`Interface method ${name}::${fn.name}() must not be abstract`, m);
        if (m.final) fail(`Interface method ${name}::${fn.name}() must not be final`, m);
        if (fn.body) fail(`Interface function ${name}::${fn.name}() cannot contain body`, m);
      } else if (m.abstract && m.vis === 'private' && kind !== 'trait') fail(`Abstract function ${name}::${fn.name}() cannot be declared private`, m);
      else if (m.abstract && fn.body) fail(`Abstract function ${name}::${fn.name}() cannot contain body`, m);
      else if (!m.abstract && !fn.body) fail(`Non-abstract method ${name}::${fn.name}() must contain body`, m);
      if (kind === 'enum' && ENUM_MAGIC.has(ln)) fail(`Enum ${name} cannot include magic method ${fn.name}`, n);
      if (kind === 'enum' && (ln === 'cases' || (n.enumType && (ln === 'from' || ln === 'tryfrom')))) fail(`Cannot redeclare ${name}::${fn.name}()`, n);
      if (ln.startsWith('__') && MAGIC_SIGS[ln]) checkMagicMethod(name, m, MAGIC_SIGS[ln]);
      if (m.vis === 'private' && m.final && ln !== '__construct') compileWarning('Private methods cannot be final as they are never overridden by other classes', m);
      for (const p of fn.params) {
        if (!p.promote) continue;
        if (ln !== '__construct') fail('Cannot declare promoted property outside a constructor', m);
        if (m.abstract || kind === 'interface') fail('Cannot declare promoted property in an abstract constructor', m);
        if (p.variadic) fail('Cannot declare variadic promoted property', m);
        if (fn.params.filter((q) => q.name === p.name).length > 1) fail(`Redefinition of parameter $${p.name}`, m);
        checkProp({ name: p.name, readonly: p.readonly || n.flags.readonly, type: p.type, static: false, hasDef: false }, m, true);
        if (p.type && p.type.alts.length === 1 && p.type.alts[0] === 'callable') fail(`Property ${name}::$${p.name} cannot have type callable`, m);
        // promoted parameters aren't implicitly nullable
        if (p.type && p.def && p.def.k === 'Lit' && p.def.v === null && !p.type.raw.includes('null') && !p.type.q && !p.type.alts.includes('mixed')) fail(`Cannot use null as default value for parameter $${p.name} of type ${typeStr(p.type, null)}`, m);
      }
    }
  }
  // zend_check_magic_method_implementation: argument count, static-ness, visibility and the types
  // a magic method may declare
  function checkMagicMethod(cname, m, sig) {
    const fn = m.fn, mname = `${cname}::${fn.name}`;
    const [nargs, isStatic, isPublic, argTypes, ret] = sig;
    if (nargs !== null) {
      const n = fn.params.filter((p) => !p.variadic).length;
      if (n !== nargs || fn.params.some((p) => p.variadic)) fail(nargs === 0 ? `Method ${mname}() cannot take arguments` : `Method ${mname}() must take exactly ${nargs} argument${nargs === 1 ? '' : 's'}`, m);
      if (fn.params.some((p) => p.byRef)) fail(`Method ${mname}() cannot take arguments by reference`, m);
    }
    if (isStatic && !m.static) fail(`Method ${mname}() must be static`, m);
    if (!isStatic && m.static) fail(`Method ${mname}() cannot be static`, m);
    if (ret === false && fn.ret) fail(`Method ${mname}() cannot declare a return type`, m);
    if (isPublic && m.vis && m.vis !== 'public') compileWarning(`The magic method ${mname}() must have public visibility`, m);
    (argTypes || []).forEach((want, i) => {
      const p = fn.params[i];
      if (!p || !p.type) return;
      const { bits } = typeBits(p.type);
      if (!bits.has(want)) fail(`${mname}(): Parameter #${i + 1} ($${p.name}) must be of type ${want} when declared`, m);
    });
    if (ret && fn.ret) {
      const { bits, complex } = typeBits(fn.ret);
      if (bits.has('never')) return;
      const allowed = new Set(ret === 'bool' ? ['true', 'false'] : ret === '?array' ? ['array', 'null'] : [ret]);
      let cx = complex;
      if (bits.has('static')) { bits.delete('static'); cx = true; }
      if ([...bits].some((b) => !allowed.has(b)) || (cx && ret !== 'object')) fail(`${mname}(): Return type must be ${ret} when declared`, m);
    }
  }
  // type declarations: redundant or impossible combinations
  function checkTypeDecl(t, where, n, propName) {
    const raw = t.raw;
    if (!raw) return;
    // only class types can be intersected
    for (const a of t.alts) {
      if (typeof a !== 'object' || !a.inter) continue;
      for (const m of a.inter) {
        const lm = m.toLowerCase();
        if (BUILTIN_TYPES.has(lm) || lm === 'self' || lm === 'parent' || lm === 'static') fail(`Type ${lm === 'iterable' ? 'Traversable|array' : lm} cannot be part of an intersection type`, n);
      }
    }
    const names = raw.filter((a) => typeof a === 'string');
    const ls = names.map((a) => a.toLowerCase());
    if (t.q) {
      const x = ls[0];
      if (x === 'mixed') fail('Type mixed cannot be marked as nullable since mixed already includes null', n);
      if (x === 'null') fail('null cannot be marked as nullable', n);
      if (x === 'void') fail('Void can only be used as a standalone type', n);
      if (x === 'never') fail('never can only be used as a standalone type', n);
    } else if (raw.length > 1) {
      if (ls.includes('mixed')) fail('Type mixed can only be used as a standalone type', n);
      if (ls.includes('void')) fail('Void can only be used as a standalone type', n);
      if (ls.includes('never')) fail('never can only be used as a standalone type', n);
      const seen = new Set();
      names.forEach((a, i) => {
        const k = ls[i];
        if (seen.has(k)) fail(`Duplicate type ${k === 'iterable' ? 'array' : BUILTIN_TYPES.has(k) ? k : a} is redundant`, n);
        seen.add(k);
      });
      if (seen.has('iterable') && seen.has('array')) fail('Duplicate type array is redundant', n);
      if (seen.has('iterable') && seen.has('traversable')) fail('Duplicate type Traversable is redundant', n);
      if (seen.has('bool') && seen.has('false')) fail('Duplicate type false is redundant', n);
      if (seen.has('bool') && seen.has('true')) fail('Duplicate type true is redundant', n);
      if (seen.has('true') && seen.has('false')) fail('Type contains both true and false, bool should be used instead', n);
      if (seen.has('object') && (ls.some((k) => !BUILTIN_TYPES.has(k) || k === 'static') || raw.some((a) => typeof a === 'object'))) fail(`Type ${typeStr(t, null)} contains both object and a class type, which is redundant`, n);
    }
    // DNF types: duplicates within an intersection, and intersections implied by another member
    const inters = raw.filter((a) => typeof a === 'object' && a.inter);
    for (const a of inters) {
      const seenI = new Set();
      for (const m of a.inter) { if (seenI.has(m.toLowerCase())) fail(`Duplicate type ${m} is redundant`, n); seenI.add(m.toLowerCase()); }
    }
    if (inters.length) {
      const set = (a) => new Set(a.inter.map((m) => m.toLowerCase()));
      const str = (a) => a.inter.join('&');
      raw.forEach((a, i) => {
        for (let j = 0; j < i; j++) {
          const b = raw[j];
          const ai = typeof a === 'object' && a.inter, bi = typeof b === 'object' && b.inter;
          if (ai && bi) {
            const [small, large] = b.inter.length <= a.inter.length ? [b, a] : [a, b];
            const ls2 = set(large);
            if (small.inter.every((m) => ls2.has(m.toLowerCase()))) {
              if (small.inter.length === large.inter.length) fail(`Type ${str(b)} is redundant with type ${str(a)}`, n);
              fail(`Type ${str(large)} is redundant as it is more restrictive than type ${str(small)}`, n);
            }
          } else if (ai !== bi) {
            const [inter, single] = ai ? [a, b] : [b, a];
            if (typeof single === 'string' && set(inter).has(single.toLowerCase())) fail(`Type ${str(inter)} is redundant as it is more restrictive than type ${single}`, n);
          }
        }
      });
    }
    const one = ls.length === 1 && raw.length === 1 ? ls[0] : null;
    if (where === 'param' && (one === 'void' || one === 'never')) fail(`${one} cannot be used as a parameter type`, n);
    if (where === 'prop' && (one === 'void' || one === 'never' || one === 'callable')) fail(`Property ${propName} cannot have type ${one}`, n);
  }
  // the attribute classes of the engine are validated at compile time; user ones only by
  // ReflectionAttribute::newInstance()
  // errors are reported at the line of the declaration (owner) the attributes belong to
  // asymmetric visibility (PHP 8.4)
  function checkSetVis(cd, p, vis, l) {
    if (!p.setVis) return;
    if (!p.type) fail(`Property with asymmetric visibility ${cd.name}::$${p.name} must have type`, { l });
    const rank = { public: 0, protected: 1, private: 2 };
    if (rank[vis] > rank[p.setVis]) fail(`Visibility of property ${cd.name}::$${p.name} must not be weaker than set visibility`, { l });
  }
  function checkAttrs(attrs, target, owner) {
    if (!attrs) return;
    const fail = (msg) => { throw new FatalSig(msg, (owner || attrs[0]).l); };
    const seen = new Set();
    for (const a of attrs) {
      if (a.args === 'fcc') fail('Cannot create Closure as attribute argument', a);
      const named = new Set();
      for (const arg of Array.isArray(a.args) ? a.args : []) {
        if (!arg || arg.spread) continue;
        if (arg.name) { if (named.has(arg.name)) fail(`Duplicate named parameter $${arg.name}`, a); named.add(arg.name); }
        else if (named.size) fail('Cannot use positional argument after named argument', a);
      }
      for (const arg of Array.isArray(a.args) ? a.args : []) {
        if (arg && arg.spread) fail('Cannot use unpacking in attribute argument list', a);
        checkConstExpr(arg && arg.e !== undefined ? arg.e : arg, true);
      }
      const ln = (a.name[0] === '\\' ? a.name.slice(1) : a.name).toLowerCase();
      const known = ENGINE_ATTRS[ln];
      if (!known || (known.since && rt.phpVersion < known.since)) continue;
      // PHP 8.5: #[\Deprecated] traits
      if (ln === 'deprecated' && target === T_CLASS && rt.phpVersion >= 80500) {
        if (owner.kind === 'trait') continue;
        fail(`Cannot apply #[\\Deprecated] to ${owner.kind} ${owner.name}`, a);
      }
      if (!(known.flags & target)) {
        const allowed = TARGET_NAMES.filter(([b]) => known.flags & b).map(([, t]) => t).join(', ');
        fail(`Attribute "${known.name}" cannot target ${TARGET_NAMES.find(([b]) => b === target)[1]} (allowed targets: ${allowed})`, a);
      }
      if (seen.has(ln)) fail(`Attribute "${known.name}" must not be repeated`, a);
      seen.add(ln);
    }
  }
  // self/static/parent need a class: a compile error in named functions outside classes
  // (closures may be bound to one later)
  function checkClassRef(name, n, ctx) {
    const ln = name.toLowerCase();
    if (!ctx || ctx.closure || (ln !== 'self' && ln !== 'static' && ln !== 'parent')) return;
    if (!ctx.cls) fail(`Cannot use "${ln}" when no class scope is active`, n);
    if (ln === 'parent' && ctx.cls && ctx.cls.kind !== 'trait' && !ctx.cls.parent) fail('Cannot use "parent" when current class scope has no parent', n);
  }
  function checkType(t, n, ctx) {
    for (const a of t.alts) {
      if (typeof a === 'string') checkClassRef(a, n, ctx);
      else for (const x of a.inter) checkClassRef(x, n, ctx);
    }
  }
  // zend_compile_const_expr: what may appear in constant expressions (constants, property and
  // parameter defaults, attribute arguments); `new` only where the value is computed at run time
  function checkConstExpr(e, allowNew) {
    if (!e || typeof e !== 'object') return;
    if (Array.isArray(e)) { for (const x of e) checkConstExpr(x, allowNew); return; }
    if (!CONST_EXPR_NODES.has(e.k)) fail('Constant expression contains invalid operations', e);
    switch (e.k) {
      case 'Lit': return;
      case 'CConst':
        if (typeof e.cls !== 'string') fail('Dynamic class names are not allowed in compile-time class constant references', e);
        if (e.cls.toLowerCase() === 'static') fail('"static::" is not allowed in compile-time constants', e);
        if (typeof e.name !== 'string') fail('Dynamic class constant fetch is not allowed in compile-time constants', e);
        return;
      case 'ClassName':
        if (typeof e.cls !== 'string') fail('(expression)::class cannot be used in constant expressions', e);
        if (e.cls.toLowerCase() === 'static') fail('static::class cannot be used for compile-time class name resolution', e);
        return;
      case 'New':
        if (!allowNew) fail('New expressions are not supported in this context', e);
        if (e.cls && e.cls.k === 'ClassDecl') fail('Cannot use anonymous class in constant expression', e);
        if (typeof e.cls !== 'string') fail('Cannot use dynamic class name in constant expression', e);
        if (e.cls.toLowerCase() === 'static') fail('"static" is not allowed in compile-time constants', e);
        for (const a of e.args || []) {
          if (a && a.spread) fail('Argument unpacking in constant expressions is not supported', e);
          checkConstExpr(a && a.e !== undefined ? a.e : a, allowNew);
        }
        return;
      case 'Arr':
        for (const it of e.items) if (it) { checkConstExpr(it.key, allowNew); checkConstExpr(it.v, allowNew); }
        return;
      case 'Prop': e.constExpr = true; break; // (only enum properties may be fetched)
    }
    for (const key in e) if (key !== 'l' && e[key] && typeof e[key] === 'object') checkConstExpr(e[key], allowNew);
  }
  function within(kind, fn) { path.push({ kind }); try { fn(); } finally { path.pop(); } }
  function visitFunction(fn) {
    const outer = scope, outerPath = path, outerCtx = fnCtx, outerFn = curFn;
    curFn = fn;
    const closure = !!(fn.closure || fn.arrow);
    fnCtx = { cls: methods.has(fn) ? curClass : closure && fnCtx ? fnCtx.cls : closure ? curClass : null, closure };
    for (const p of fn.params) if (p.type) checkType(p.type, fn, fnCtx);
    if (fn.ret) checkType(fn.ret, fn, fnCtx);
    scope = newScope(); path = [];
    scope.byRef = !!fn.byRef; scope.ret = fn.ret; scope.isGen = !!fn.isGen;
    const pnames = new Set();
    for (const p of fn.params) {
      if (p.name === 'this') fail('Cannot use $this as parameter', fn);
      if (pnames.has(p.name)) fail(`Redefinition of parameter $${p.name}`, fn);
      pnames.add(p.name);
      if (p.type) checkTypeDecl(p.type, 'param', fn);
    }
    if (fn.ret) checkTypeDecl(fn.ret, 'return', fn);
    // #[\NoDiscard] needs a return value (PHP 8.5)
    if (rt.phpVersion >= 80500 && hasAttrName(fn.attrs, 'nodiscard') && fn.ret && !fn.ret.q && fn.ret.raw.length === 1 && typeof fn.ret.raw[0] === 'string') {
      const r = fn.ret.raw[0].toLowerCase(), what = methods.has(fn) ? 'method' : 'function';
      if (r === 'void') fail(`A void ${what} does not return a value, but #[\\NoDiscard] requires a return value`, fn);
      if (r === 'never') fail(`A never returning ${what} does not return a value, but #[\\NoDiscard] requires a return value`, fn);
    }
    if (!methods.has(fn) && fn.params.some((p) => p.promote)) fail('Cannot declare promoted property outside a constructor', fn);
    if (fn.isGen && fn.ret) {
      const { bits } = typeBits(fn.ret);
      const ok = bits.has('object') || fn.ret.alts.some((a) => typeof a === 'string' && /^(traversable|iterator|generator|iterable)$/i.test(a.replace(/^\\/, '')));
      if (!ok) fail(`Generator return type must be a supertype of Generator, ${typeStr(fn.ret, null)} given`, fn);
    }
    const unames = new Set();
    for (const u of fn.uses || []) {
      if (u.name === 'this') fail('Cannot use $this as lexical variable', fn);
      if (AUTO_GLOBALS.has(u.name)) fail('Cannot use auto-global as lexical variable', fn);
      if (unames.has(u.name)) fail(`Cannot use variable $${u.name} twice`, fn);
      if (pnames.has(u.name)) fail(`Cannot use lexical variable $${u.name} as a parameter name`, fn);
      unames.add(u.name);
    }
    // an optional parameter before a required one is required (except PHP 5 style `T $x = null`)
    let lastRequired = -1;
    fn.params.forEach((p, i) => { if (!p.def && !p.variadic) lastRequired = i; });
    fn.params.forEach((p, i) => {
      if (!p.def || i >= lastRequired) return;
      const implicitNullable = p.type && !p.type.nullable && p.def.k === 'Lit' && p.def.v === null;
      if (!implicitNullable) compileDeprecated(`Optional parameter $${p.name} declared before required parameter $${fn.params[lastRequired].name} is implicitly treated as a required parameter`, p.def.l ? p.def : fn);
    });
    if (!methods.has(fn)) checkAttrs(fn.attrs, T_FUNCTION, fn);
    for (const p of fn.params) {
      checkAttrs(p.attrs, T_PARAMETER, fn);
      checkConstExpr(p.def, true);
      if (p.type && p.def) {
        const lit = literalValue(p.def);
        if (lit !== NOT_LITERAL && lit !== null && !validDefault(p.type, lit)) fail(`Cannot use ${literalType(lit)} as default value for parameter $${p.name} of type ${typeStr(p.type, null)}`, p.def.l ? p.def : fn);
      }
    }
    visit(fn.params, READ); visit(fn.body, READ); visit(fn.arrowExpr, READ);
    checkGotos(scope, !fn.params.length && !fn.isGen ? fn.body : null);
    scope = outer; path = outerPath; fnCtx = outerCtx; curFn = outerFn;
  }
  // body: the statements, when a leading goto would be the function's first opcode
  function checkGotos(sc, body) {
    // PHP 8.3 quirk: in a function that has a finally block, its check for jumps out of finally
    // blocks treats every try without finally as covering opcode 0, so a goto compiled as the
    // very first opcode is rejected (zend_check_finally_breakout)
    if (body && sc.hasFinally && sc.hasTryWithoutFinally) {
      const first = body.find((st) => st && !NO_OPCODES.has(st.k));
      if (first && first.k === 'Goto') fail('jump out of a finally block is disallowed', first);
    }
    for (const { n, path: from } of sc.gotos) {
      const to = sc.labels.get(n.label);
      if (!to) fail(`'goto' to undefined label '${n.label}'`, n);
      let p = 0;
      while (p < to.length && p < from.length && to[p] === from[p]) p++;
      for (const c of to.slice(p)) {
        if (c.kind === 'loop' || c.kind === 'switch') fail("'goto' into loop or switch statement is disallowed", n);
        if (c.kind === 'finally') fail('jump into a finally block is disallowed', n);
      }
      if (from.slice(p).some((c) => c.kind === 'finally')) fail('jump out of a finally block is disallowed', n);
    }
  }

  visit(ast, READ);
  checkGotos(scope, ast);
}

// statements that compile to no opcodes of their own
const NO_OPCODES = new Set(['Label', 'FuncDecl']);

// the value of a default that is a literal (possibly folded: -1, 1 + 1.5, [1, 2]), else NOT_LITERAL
const NOT_LITERAL = Symbol('not literal');
function isLiteralTree(n) {
  if (!n || typeof n !== 'object') return false;
  switch (n.k) {
    case 'Lit': return true;
    case 'Const': return ['true', 'false', 'null'].includes(n.name.replace(/^\\/, '').toLowerCase());
    case 'Neg': case 'Plus': case 'Not': case 'BitNot': return isLiteralTree(n.e);
    case 'Bin': return isLiteralTree(n.a) && isLiteralTree(n.b);
    case 'Arr': return n.items.every((it) => it && !it.spread && (!it.key || isLiteralTree(it.key)) && isLiteralTree(it.v));
  }
  return false;
}
function literalValue(n) {
  if (!isLiteralTree(n)) return NOT_LITERAL;
  try { return cExpr(n)(new Frame(null, null, null, null)); } catch (e) { return NOT_LITERAL; }
}
function literalType(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number' || typeof v === 'bigint') return 'int';
  if (v instanceof Flt) return 'float';
  if (typeof v === 'string') return 'string';
  if (v instanceof PHPArray) return 'array';
  return 'null';
}
// zend_is_valid_default_value
function validDefault(type, v) {
  const alts = type.alts.map((a) => (typeof a === 'string' ? a.toLowerCase() : a));
  if (alts.includes('mixed')) return true;
  switch (literalType(v)) {
    case 'bool': return alts.includes('bool') || alts.includes(v ? 'true' : 'false');
    case 'int': return alts.includes('int') || alts.includes('float');
    case 'float': return alts.includes('float');
    case 'string': return alts.includes('string');
    case 'array': return alts.includes('array') || alts.includes('iterable');
  }
  return true;
}
function newScope() { return { labels: new Map(), gotos: [] }; }

const BUILTIN_TYPES = new Set(['int', 'float', 'string', 'bool', 'array', 'object', 'callable', 'iterable', 'mixed', 'void', 'never', 'null', 'false', 'true', 'static', 'self', 'parent']);
const ENUM_MAGIC = new Set(['__construct', '__destruct', '__clone', '__get', '__set', '__unset', '__isset', '__tostring', '__debuginfo', '__serialize', '__unserialize', '__sleep', '__wakeup', '__set_state']);
function hasAttrName(attrs, lname) { return !!attrs && attrs.some((a) => (a.name[0] === '\\' ? a.name.slice(1) : a.name).toLowerCase() === lname); }
const CLASS_REF_NODES = new Set(['CConst', 'ClassName', 'New', 'SCall', 'SProp', 'Instanceof']);
const T_CLASS = 1, T_FUNCTION = 2, T_METHOD = 4, T_PROPERTY = 8, T_CLASS_CONSTANT = 16, T_PARAMETER = 32;
const TARGET_NAMES = [[T_CLASS, 'class'], [T_FUNCTION, 'function'], [T_METHOD, 'method'], [T_PROPERTY, 'property'], [T_CLASS_CONSTANT, 'class constant'], [T_PARAMETER, 'parameter']];
const ENGINE_ATTRS = {
  attribute: { name: 'Attribute', flags: T_CLASS },
  override: { name: 'Override', flags: T_METHOD },
  allowdynamicproperties: { name: 'AllowDynamicProperties', flags: T_CLASS },
  returntypewillchange: { name: 'ReturnTypeWillChange', flags: T_METHOD },
  sensitiveparameter: { name: 'SensitiveParameter', flags: T_PARAMETER },
  deprecated: { name: 'Deprecated', flags: T_METHOD | T_FUNCTION | T_CLASS_CONSTANT, since: 80400 },
  nodiscard: { name: 'NoDiscard', flags: T_METHOD | T_FUNCTION, since: 80500 },
};
