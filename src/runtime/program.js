// Compiling and running programs: include/require, eval, hoisting of declarations.

import pathMod from 'node:path';
import fs from 'node:fs';
import { FatalSig, ParseErr, ThrowSig } from '../values.js';
import { lex } from '../lexer.js';
import { parsePHP, Parser } from '../parser.js';
import { RETURN } from '../compiler/common.js';
import { cStmts } from '../compiler/stmt.js';
import { rt } from './state.js';
import { makeException, throwError, warn } from './errors.js';
import { declareFunction, NativeFrame } from './functions.js';
import { declareClass } from './classes.js';

export function compileSource(src, file) {
  let ast;
  try { ast = parsePHP(src, file); }
  catch (e) {
    if (e instanceof ParseErr) throw new FatalSig(e.msg, e.line, file, e.kind || 'Parse error');
    throw e;
  }
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
  // declare classes whose dependencies are available, repeat until fixpoint
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
  hoistDecls(prog.ast, f);
  const r = prog.body(f);
  return r === RETURN ? f.ret : 1;
}

function resolveIncludePath(p) {
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
    } catch (e) {
      if (!(e instanceof ParseErr)) throw e;
      const ex = makeException('ParseError', e.msg);
      ex.props.set('file', file); ex.props.set('line', e.line);
      throw new ThrowSig(ex);
    }
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
    if (kind.startsWith('require')) {
      warn(`${kind}(${path}): Failed to open stream: No such file or directory`);
      throwError('Error', `Failed opening required '${path}' (include_path='${rt.ini.get('include_path') || '.:/usr/share/php'}')`);
    }
    warn(`${kind}(${path}): Failed to open stream: No such file or directory`);
    warn(`${kind}(): Failed opening '${path}' for inclusion (include_path='${rt.ini.get('include_path') || '.:/usr/share/php'}')`);
    return false;
  }
  const real = fs.realpathSync(resolved);
  if (kind.endsWith('_once') && rt.included.has(real)) return true;
  rt.included.add(real);
  let prog = rt.progCache.get(real);
  if (!prog) { prog = compileSource(fs.readFileSync(real, 'latin1'), real); rt.progCache.set(real, prog); }
  const prevFile = rt.file, prevLine = rt.line;
  const nf = new NativeFrame({ name: kind, isMethod: false }, [real]); nf.native = false;
  rt.stack.push(nf);
  rt.file = real;
  try { return runProgram(prog, f); }
  finally { rt.file = prevFile; rt.line = prevLine; rt.stack.pop(); }
}
