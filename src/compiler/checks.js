// Compile-time checks: errors PHP reports for a whole file before running any of it.
//
// NIP compiles function bodies lazily, so errors PHP finds while compiling must be looked for
// here, right after parsing, to be reported for code that never runs and before any output.

import { FatalSig } from '../values.js';
import { rt } from '../runtime/state.js';
import { typeStr } from '../runtime/functions.js';

// How an expression is used: read, written (assignment target, by-ref argument, ...), unset,
// or passed as an argument whose by-ref-ness is only known at run time.
// ASSIGN: the target itself is assigned ($x = ..., foreach targets, list() items)
const READ = 0, WRITE = 1, UNSET = 2, ARG = 3, ASSIGN = 4;
// zend_is_variable_or_call: what can be written through ($a[0] = 1, f()->x = 1); anything else is
// a temporary value
const VAR_OR_CALL = new Set(['Var', 'VarVar', 'Index', 'Prop', 'SProp', 'Call', 'MCall', 'NullsafeMCall', 'SCall']);
const CONST_EXPR_NODES = new Set(['Lit', 'Bin', 'And', 'Or', 'Xor', 'Not', 'BitNot', 'Neg', 'Plus', 'Ternary', 'Index', 'Arr',
  'Const', 'CConst', 'ClassName', 'Name', 'MagicClass', 'MagicMethod', 'Coalesce', 'New', 'Prop']);
const isTemp = (n) => !!n && typeof n === 'object' && !Array.isArray(n) && !VAR_OR_CALL.has(n.k);

export function checkProgram(ast) {
  const seen = new WeakSet();
  const fail = (msg, n) => { throw new FatalSig(msg, n.l); };
  // goto: labels and gotos of the current function, and the loops/switches/finally blocks
  // enclosing the statement being visited
  let scope = newScope(), path = [];
  const methods = new WeakSet(); // function nodes that are methods (attribute target "method")
  // the function being checked: null at the top level (which may run inside a class via
  // include), else { cls: enclosing ClassDecl or null, closure }
  let fnCtx = null, curClass = null;

  function visit(n, ctx) {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    if (Array.isArray(n)) { for (const x of n) visit(x, ctx); return; }
    seen.add(n);
    if (!n.k && Array.isArray(n.params) && Array.isArray(n.body)) { visitFunction(n); return; }
    if (typeof n.cls === 'string' && CLASS_REF_NODES.has(n.k)) checkClassRef(n.cls, n, fnCtx);
    switch (n.k) {
      case 'Lit': return;
      case 'ClassDecl': {
        checkClass(n);
        checkAttrs(n.attrs, T_CLASS);
        for (const m of n.methods) { checkAttrs(m.fn.attrs, T_METHOD); methods.add(m.fn); }
        for (const p of n.props) { checkAttrs(p.attrs, T_PROPERTY); if (p.type) checkType(p.type, p, { cls: n, closure: false }); }
        for (const c of n.consts) { checkAttrs(c.attrs, T_CLASS_CONSTANT); checkConstExpr(c.e, false); }
        for (const c of n.cases) { checkAttrs(c.attrs, T_CLASS_CONSTANT); checkConstExpr(c.e, false); }
        for (const p of n.props) checkConstExpr(p.def, false);
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
      case 'Assign': case 'AssignOp': visit(n.t, ASSIGN); visit(n.e, READ); return;
      case 'AssignRef':
        if (n.e && n.e.k === 'Prop' && n.e.nullsafe) fail('Cannot take reference of a nullsafe chain', n);
        visit(n.t, ASSIGN); visit(n.e, WRITE); return;
      case 'PreInc': case 'PreDec': case 'PostInc': case 'PostDec': visit(n.e, WRITE); return;
      case 'Unset': visit(n.list, UNSET); return;
      case 'Arr':
        if (ctx !== WRITE && ctx !== ASSIGN) break;
      // falls through: [$a, $b] = ... destructuring
      case 'List': {
        const items = (n.items || []).filter(Boolean);
        if (!items.length) fail('Cannot use empty list', n);
        if (items.some((it) => it.spread)) fail('Spread operator is not supported in assignments', n);
        if (items.some((it) => it.key) && items.some((it) => !it.key)) fail('Cannot mix keyed and unkeyed array entries in assignments', n);
        for (const it of items) {
          let t = it.v;
          while (t && (t.k === 'Index' || t.k === 'Prop')) t = t.o;
          if (it.v && it.v.k !== 'Arr' && it.v.k !== 'List' && isTemp(t)) fail('Assignments can only happen to writable values', n);
        }
        for (const it of items) { visit(it.key, READ); visit(it.v, it.byRef ? WRITE : ASSIGN); }
        return;
      }
      case 'Call': visit(n.f, READ); visitArgs(n.args, typeof n.f === 'string' ? builtin(n) : null, n); return;
      case 'MCall': case 'NullsafeMCall': visit(n.o, READ); if (typeof n.name === 'object') visit(n.name, READ); visitArgs(n.args, null, n); return;
      case 'SCall': case 'New': visit(n.cls, READ); if (typeof n.name === 'object') visit(n.name, READ); visitArgs(n.args, null, n); return;
      case 'ConstDecl': for (const it of n.items) checkConstExpr(it.e, true); break;
      case 'Global':
        for (const x of n.names) if (x === 'this') fail('Cannot use $this as global variable', n);
        break;
      case 'StaticVar':
        for (const v of n.vars) if (v.name === 'this') fail('Cannot use $this as static variable', n);
        break;
      case 'Label':
        if (scope.labels.has(n.name)) fail(`Label '${n.name}' already defined`, n);
        scope.labels.set(n.name, path.slice());
        return;
      case 'Goto': scope.gotos.push({ n, path: path.slice() }); return;
      case 'Return': {
        const ret = scope.ret && !scope.isGen && scope.ret.raw && scope.ret.raw.length === 1 && !scope.ret.q && typeof scope.ret.raw[0] === 'string' ? scope.ret.raw[0].toLowerCase() : null;
        if (ret === 'void' && n.e) fail(n.e.k === 'Lit' && n.e.v === null ? 'A void function must not return a value (did you mean "return;" instead of "return null;"?)' : 'A void function must not return a value', n);
        if (ret === 'never') fail('A never-returning function must not return', n);
        visit(n.e, scope.byRef ? WRITE : READ); return; // function &f() { return $a[]; }
      }
      case 'While': case 'DoWhile': case 'For': case 'Foreach': case 'Switch': {
        const { body, cases, ...rest } = n;
        if (n.k === 'Switch') {
          const defaults = n.cases.filter((c) => !c.test);
          if (defaults.length > 1) fail('Switch statements may only contain one default clause', defaults[1]);
        }
        const ctxOf = (key) => (key === 'kv' || key === 'v' ? ASSIGN : key === 'e' && n.k === 'Foreach' && n.byRef ? WRITE : READ);
        for (const key in rest) if (key !== 'l' && key !== 'k') visit(rest[key], ctxOf(key));
        within('loop', () => { visit(body, READ); visit(cases, READ); });
        return;
      }
      case 'Try':
        for (const c of n.catches) if (c.v === 'this') fail('Cannot re-assign $this', n);
        if (n.fin) scope.hasFinally = true; else scope.hasTryWithoutFinally = true;
        within('try', () => { visit(n.body, READ); visit(n.catches, READ); });
        within('finally', () => visit(n.fin, READ));
        return;
    }
    for (const key in n) if (key !== 'l') visit(n[key], READ);
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
      if (a.spread) unpacked = true;
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
    if (kind === 'enum' && n.enumType) {
      const bt = n.enumType.raw && n.enumType.raw.length === 1 ? String(n.enumType.raw[0]).toLowerCase() : 'mixed';
      if (bt !== 'int' && bt !== 'string') fail(`Enum backing type must be int or string, ${typeStr(n.enumType, null, true)} given`, n);
    }
    const consts = new Set();
    for (const c of [...n.consts, ...n.cases].sort((a, b) => a.seq - b.seq)) {
      if (consts.has(c.name)) fail(`Cannot redefine class constant ${name}::${c.name}`, c);
      consts.add(c.name);
      if (kind === 'interface' && c.vis && c.vis !== 'public') fail(`Access type for interface constant ${name}::${c.name} must be public`, c);
    }
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
      if (kind === 'interface') fail('Interfaces may not include properties', p);
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
        if (m.final) fail(`Interface method ${name}::${fn.name}() must not be final`, m);
        if (fn.body) fail(`Interface function ${name}::${fn.name}() cannot contain body`, m);
      } else if (m.abstract && fn.body) fail(`Abstract function ${name}::${fn.name}() cannot contain body`, m);
      else if (!m.abstract && !fn.body) fail(`Non-abstract method ${name}::${fn.name}() must contain body`, m);
      if (kind === 'enum' && ENUM_MAGIC.has(ln)) fail(`Enum ${name} cannot include magic method ${fn.name}`, m);
      for (const p of fn.params) {
        if (!p.promote) continue;
        if (ln !== '__construct') fail('Cannot declare promoted property outside a constructor', m);
        if (m.abstract || kind === 'interface') fail('Cannot declare promoted property in an abstract constructor', m);
        if (p.variadic) fail('Cannot declare variadic promoted property', m);
        if (fn.params.filter((q) => q.name === p.name).length > 1) fail(`Redefinition of parameter $${p.name}`, m);
        checkProp({ name: p.name, readonly: p.readonly || n.flags.readonly, type: p.type, static: false, hasDef: false }, m, true);
      }
    }
  }
  // type declarations: redundant or impossible combinations
  function checkTypeDecl(t, where, n, propName) {
    const raw = t.raw;
    if (!raw) return;
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
        if (seen.has(k)) fail(`Duplicate type ${BUILTIN_TYPES.has(k) ? k : a} is redundant`, n);
        seen.add(k);
      });
      if (seen.has('iterable') && seen.has('array')) fail('Duplicate type array is redundant', n);
      if (seen.has('iterable') && seen.has('traversable')) fail('Duplicate type Traversable is redundant', n);
      if (seen.has('bool') && seen.has('false')) fail('Duplicate type false is redundant', n);
      if (seen.has('bool') && seen.has('true')) fail('Duplicate type true is redundant', n);
      if (seen.has('true') && seen.has('false')) fail('Type contains both true and false, bool should be used instead', n);
      if (seen.has('object') && ls.some((k) => !BUILTIN_TYPES.has(k))) fail(`Type ${typeStr(t, null, true)} contains both object and a class type, which is redundant`, n);
    }
    const one = ls.length === 1 && raw.length === 1 ? ls[0] : null;
    if (where === 'param' && (one === 'void' || one === 'never')) fail(`${one} cannot be used as a parameter type`, n);
    if (where === 'prop' && (one === 'void' || one === 'never' || one === 'callable')) fail(`Property ${propName} cannot have type ${one}`, n);
  }
  // the attribute classes of the engine are validated at compile time; user ones only by
  // ReflectionAttribute::newInstance()
  function checkAttrs(attrs, target) {
    if (!attrs) return;
    const seen = new Set();
    for (const a of attrs) {
      for (const arg of a.args || []) {
        if (arg && arg.spread) fail('Cannot use unpacking in attribute argument list', a);
        checkConstExpr(arg && arg.e !== undefined ? arg.e : arg, true);
      }
      const ln = (a.name[0] === '\\' ? a.name.slice(1) : a.name).toLowerCase();
      const known = ENGINE_ATTRS[ln];
      if (!known) continue;
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
    }
    for (const key in e) if (key !== 'l' && e[key] && typeof e[key] === 'object') checkConstExpr(e[key], allowNew);
  }
  function within(kind, fn) { path.push({ kind }); try { fn(); } finally { path.pop(); } }
  function visitFunction(fn) {
    const outer = scope, outerPath = path, outerCtx = fnCtx;
    const closure = fn.name === '{closure}';
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
    for (const u of fn.uses || []) if (u.name === 'this') fail('Cannot use $this as lexical variable', fn);
    if (!methods.has(fn)) checkAttrs(fn.attrs, T_FUNCTION);
    for (const p of fn.params) { checkAttrs(p.attrs, T_PARAMETER); checkConstExpr(p.def, true); }
    visit(fn.params, READ); visit(fn.body, READ); visit(fn.arrowExpr, READ);
    checkGotos(scope, !fn.params.length && !fn.isGen ? fn.body : null);
    scope = outer; path = outerPath; fnCtx = outerCtx;
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
        if (c.kind === 'loop') fail("'goto' into loop or switch statement is disallowed", n);
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
};
