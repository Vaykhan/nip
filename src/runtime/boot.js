// Interpreter boot (prelude, native classes, constants) and per-run state reset.

import { PHPResource } from '../values.js';
import { Frame } from '../compiler/common.js';
import { lvVarCache } from '../compiler/lvalue.js';
import { E_ALL, E_DEPRECATED, E_STRICT, rt } from './state.js';
import { declareClass } from './classes.js';
import { resetObjHandles } from './gc.js';
import { compileSource, hoistDecls, runProgram } from './program.js';
import { resetJsonState } from '../lib/json.js';
import { resetPcreState } from '../lib/pcre.js';
import { bootNativeClasses } from './native-classes.js';
import { PRELUDE_CORE, PRELUDE_LAZY, readPrelude } from '../prelude.js';
import { defConsts } from './constants.js';

let booted = false, snapshot = null;
export const lazyClassSrc = new Map(), lazyFnSrc = new Map(), lazyLoaded = new Set();
function loadLazy(src) {
  if (lazyLoaded.has(src)) return false;
  lazyLoaded.add(src);
  const prevFile = rt.file, prevLine = rt.line, prevFrame = rt.frame;
  try {
    const prog = compileSource(src, 'prelude.php');
    const f = new Frame(null, null, null, null);
    rt.frame = f;
    runProgram(prog, f);
  } finally { rt.file = prevFile; rt.line = prevLine; rt.frame = prevFrame; }
  return true;
}
export function lazyClass(ln) { const src = lazyClassSrc.get(ln); if (src && loadLazy(src)) return rt.classes.get(ln) || null; return null; }
export function lazyFn(ln) { if (rt.disabledFns && rt.disabledFns.has(ln)) return undefined; const src = lazyFnSrc.get(ln); if (src && loadLazy(src)) return rt.fns.get(ln); return undefined; }
export function boot() {
  if (booted) return;
  booted = true;
  // interfaces needed by native classes are in the prelude; declare Traversable/Iterator first
  for (const name of PRELUDE_LAZY) {
    const src = readPrelude(name);
    for (const m of src.matchAll(/^(?:abstract |final )*(?:class|interface|trait) (\w+)/gm)) lazyClassSrc.set(m[1].toLowerCase(), src);
    for (const m of src.matchAll(/^function (\w+)/gm)) lazyFnSrc.set(m[1].toLowerCase(), src);
  }
  const pre = compileSource(readPrelude(PRELUDE_CORE), 'prelude.php');
  // native classes depending on Iterator are created after first prelude statements; split
  const ast = pre.ast;
  const firstIdx = ast.findIndex((s) => s.k === 'ClassDecl' && s.name === '__ThrowableImpl');
  const f = new Frame(null, null, null, null);
  rt.frame = f; rt.file = 'prelude.php';
  defConsts();
  for (let i = 0; i < firstIdx; i++) declareClass(ast[i], f);
  bootNativeClasses();
  hoistDecls(ast.slice(firstIdx), f);
  for (const s of ast.slice(firstIdx)) if (s.k === 'ClassDecl' && !s.declared) declareClass(s, f);
  for (const k of [...rt.fns.keys()]) { const fn = rt.fns.get(k); if (!fn.native) fn.prelude = true; }
  rt.userFnNames.clear();
  snapshot = { fns: new Map(rt.fns), classes: new Map(rt.classes), consts: new Map(rt.consts) };
}
export function resetRuntime() {
  rt.epoch++;
  rt.tickFns = []; rt.tickCount = 0; rt.fiberSwitchBlocked = 0; rt.currentFiber = null; rt.suspendedFibers = new Set();
  rt.fns = new Map(snapshot.fns); rt.classes = new Map(snapshot.classes); rt.consts = new Map(snapshot.consts);
  rt.userFnNames = new Set(); rt.globals = Object.create(null); rt.stack = []; rt.depth = 0; rt.silence = 0;
  rt.errorHandlers = []; rt.exceptionHandlers = []; rt.shutdownFns = []; rt.autoloaders = []; rt.included = new Set();
  rt.obStack = []; rt.outBuf = ''; rt.destructibles = []; rt.inShutdown = false; rt.lastRetRef = null; rt.lastError = null; rt.ini = new Map(); rt.mainStatics = null;
  rt.errorReporting = E_ALL & ~E_DEPRECATED & ~E_STRICT; rt.displayErrors = 'stderr'; rt.precision = 14; rt.serializePrecision = -1;
  resetJsonState(); resetPcreState(); resetObjHandles(); rt.staticOwners = new Set(); rt.constRoots = []; rt.deadline = 0; rt.timeLimit = 0;
  PHPResource.n = 4;
  lvVarCache.clear(); lazyLoaded.clear();
}
