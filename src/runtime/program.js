// Compiling and running programs: include/require, eval, hoisting of declarations.

import pathMod from 'node:path';
import fs from 'node:fs';
import { FatalSig, ParseErr, ThrowSig } from '../values.js';
import { lex } from '../lexer.js';
import { mergeCompileWarnings, parsePHP, Parser } from '../parser.js';
import { RETURN } from '../compiler/common.js';
import { checkProgram } from '../compiler/checks.js';
import { cStmts } from '../compiler/stmt.js';
import { rt } from './state.js';
import { makeException, PRELUDE_FILE, throwError, warn } from './errors.js';
import { declareFunction, NativeFrame } from './functions.js';
import { classExists, declareClass } from './classes.js';
import { UNRESOLVED } from './inheritance.js';

export function compileSource(src, file) {
  let ast;
  try { ast = parsePHP(src, file); }
  catch (e) {
    if (e instanceof ParseErr) throw new FatalSig(e.msg, e.line, file, e.kind || 'Parse error');
    throw e;
  }
  try { checkProgram(ast, file); }
  catch (e) { if (e instanceof FatalSig && !e.file) e.file = file; throw e; }
  return { ast, body: null, file };
}
export function hoistDecls(ast, f) {
  const fns = [], classes = [];
  const scan = (list) => {
    for (const s of list) {
      if (!s) continue;
      if (s.k === 'FuncDecl') fns.push(s);
      else if (s.k === 'ClassDecl') classes.push(s);
      else if (s.k === 'Block' && s.top) scan(s.body);
    }
  };
  scan(ast);
  for (const s of fns) { declareFunction(s.fn); s.hoisted = true; }
  if (classes.length && classes[0].file === PRELUDE_FILE) { hoistPrelude(classes, f); return; }
  // PHP declares a class at compile time ("early binding") only when it uses no traits, implements
  // no interfaces, and its parent is already declared; the others are declared when execution
  // reaches them
  const saved = rt.hoisting;
  rt.hoisting = true;
  try {
    for (const c of classes) {
      if (c.declared || c.kind === 'enum' || c.traits.length || c.interfaces.length) continue;
      if (c.parent && !classExists(c.parent, false)) continue;
      if (rt.classes.has(c.name.toLowerCase())) continue;
      try { declareClass(c, f); } catch (e) { if (e !== UNRESOLVED) throw e; }
    }
  } finally { rt.hoisting = saved; }
}
// the prelude may use classes before declaring them: declare classes whose dependencies are
// available, repeat until fixpoint
function hoistPrelude(classes, f) {
  let progress = true;
  const pending = classes.filter((c) => !c.declared);
  while (progress && pending.length) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      const deps = [c.parent, ...c.interfaces, ...c.traits.flatMap((t) => t.names)].filter(Boolean);
      if (deps.every((d) => rt.classes.has(d.toLowerCase()))) {
        if (rt.classes.has(c.name.toLowerCase())) { pending.splice(i--, 1); continue; }
        declareClass(c, f);
        pending.splice(i--, 1);
        progress = true;
      }
    }
  }
}
export function runProgram(prog, f) {
  if (!prog.body) prog.body = cStmts(prog.ast);
  const prevStrict = rt.mainStrict;
  rt.mainStrict = !!prog.ast.strict;
  try {
    hoistDecls(prog.ast, f);
    const r = prog.body(f);
    return r === RETURN ? f.ret : 1;
  } finally { rt.mainStrict = prevStrict; }
}

export function resolveIncludePath(p) {
  if (p === '') return null;
  const tryFile = (x) => { try { return fs.statSync(x).isFile() ? x : null; } catch (e) { return null; } };
  if (pathMod.isAbsolute(p)) return tryFile(p);
  if (p.startsWith('./') || p.startsWith('../')) return tryFile(pathMod.resolve(process.cwd(), p));
  const inc = (rt.ini.get('include_path') || '.').split(':');
  for (const d of inc) { const r = tryFile(pathMod.resolve(process.cwd(), d, p)); if (r) return r; }
  if (rt.file) { const r = tryFile(pathMod.resolve(pathMod.dirname(rt.file), p)); if (r) return r; }
  return null;
}
const evalCache = new Map();
export function doEval(code, f, st) {
  const file = `${rt.file}(${rt.line}) : eval()'d code`;
  const key = file + '\0' + code;
  let prog = evalCache.get(key);
  if (!prog) {
    let ast;
    try {
      const toks = lex('<?php ' + code, file);
      const p = new Parser(toks, file, Object.assign({ fnStack: [], clsStack: [], anonCount: 0, strict: false }, st));
      ast = p.parseProgram();
      ast.compileWarnings = mergeCompileWarnings(toks, p);
    } catch (e) {
      if (!(e instanceof ParseErr)) throw e;
      const ex = makeException('ParseError', e.msg);
      ex.props.set('file', file); ex.props.set('line', e.line);
      throw new ThrowSig(ex);
    }
    try { checkProgram(ast, file); }
    catch (e) { if (e instanceof FatalSig && !e.file) e.file = file; throw e; }
    prog = { ast, body: cStmts(ast), file };
    if (evalCache.size > 1000) evalCache.clear();
    evalCache.set(key, prog);
  }
  const prevFile = rt.file, prevLine = rt.line;
  rt.file = file;
  try {
    hoistDecls(prog.ast, f);
    const r = prog.body(f);
    return r === RETURN ? f.ret : null;
  } finally { rt.file = prevFile; rt.line = prevLine; }
}
export function doInclude(path, kind, f) {
  const resolved = resolveIncludePath(path);
  if (!resolved) {
    // the warnings come from inside include(), which shows in backtraces
    const nf = new NativeFrame({ name: kind, isMethod: false }, []); nf.native = false;
    rt.stack.push(nf);
    try {
      warn(`${kind}(${path}): Failed to open stream: No such file or directory`);
      if (!kind.startsWith('require')) warn(`${kind}(): Failed opening '${path}' for inclusion (include_path='${rt.ini.get('include_path') || '.:/usr/share/php'}')`);
    } finally { rt.stack.pop(); }
    if (kind.startsWith('require')) throwError('Error', `Failed opening required '${path}' (include_path='${rt.ini.get('include_path') || '.:/usr/share/php'}')`);
    return false;
  }
  const real = fs.realpathSync(resolved);
  if (kind.endsWith('_once') && rt.included.has(real)) return true;
  rt.included.add(real);
  // compiled includes are cached across runs and revalidated by mtime and size (like opcache.validate_timestamps)
  const st = fs.statSync(real);
  let cached = rt.progCache.get(real), prog;
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) prog = cached.prog;
  else { prog = compileSource(fs.readFileSync(real, 'latin1'), real); rt.progCache.set(real, { prog, mtimeMs: st.mtimeMs, size: st.size }); }
  const prevFile = rt.file, prevLine = rt.line;
  const nf = new NativeFrame({ name: kind, isMethod: false }, [real]); nf.native = false;
  rt.stack.push(nf);
  rt.file = real;
  try { return runProgram(prog, f); }
  finally { rt.file = prevFile; rt.line = prevLine; rt.stack.pop(); }
}
