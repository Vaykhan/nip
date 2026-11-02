// PHP 8.4 lazy objects (ReflectionClass::newLazyGhost() and friends). A lazy object's state is
// filled in on first use: a ghost's initializer fills in the object itself, and a proxy's factory
// returns the real instance, which the proxy forwards property accesses to from then on.
//
// obj.lazy (undefined for ordinary objects):
//   proxy     whether the object is a proxy
//   init      the initializer or factory (null once a proxy is initialized)
//   options   ReflectionClass::SKIP_* flags
//   keys      the property slots that are still lazy: accessing one that holds no value
//             initializes the object (accesses of other properties don't)
//   all       the slots that were lazy to begin with
//   instance  a proxy's real instance, once initialized
// A ghost drops obj.lazy once initialized; an initialized proxy keeps it.

import { cp, PHPObject, Ref } from '../values.js';
import { typeOf } from '../convert.js';
import { throwError } from './errors.js';
import { callValue } from './callables.js';
import { propDefault } from './classes.js';

export const LAZY_SKIP_SERIALIZE = 8, LAZY_SKIP_DESTRUCTOR = 16;
// objects whose initializer is running (they can't be reset meanwhile)
export const lazyRunning = new Set();

// (keep: slots that keep their values and aren't lazy)
export function makeLazy(obj, cls, proxy, init, options, keep) {
  const keys = new Set();
  for (const [key, info] of cls.slots) if (!info.virtual && !info.internal && !(keep && keep.has(key))) keys.add(key);
  obj.lazy = { proxy, init, options, keys, all: new Set(keys), instance: null };
  if (keys.size === 0) obj.lazy = undefined; // (nothing to initialize)
}
// an uninitialized lazy object (or an initialized proxy)
export const isLazy = (o) => o.lazy !== undefined;
export const isUninitLazy = (o) => o.lazy !== undefined && o.lazy.instance === null;
// whether accessing the slot (undefined: a dynamic property) of a lazy object initializes it
export const lazySlot = (o, key, info) => info === undefined || o.lazy.keys.has(key);
// the object a property access of a lazy object goes to: the object itself (a ghost, now
// initialized) or a proxy's real instance
export function lazyInit(obj) {
  const lz = obj.lazy;
  if (lz.instance !== null) return lz.instance.lazy !== undefined ? lazyInit(lz.instance) : lz.instance; // (the instance may have been reset as lazy)
  return lz.proxy ? initProxy(obj, lz) : initGhost(obj, lz);
}
// the object whose properties an enumeration (foreach, get_object_vars(), ...) of `o` shows
export const lazyTarget = (o) => (o.lazy === undefined ? o : lazyInit(o));

function lazySnapshot(obj) {
  const saved = [];
  for (const [k, v] of obj.props) saved.push([k, v instanceof Ref ? v : cp(v), v instanceof Ref ? v.v : undefined]);
  return saved;
}
function lazyRestore(obj, saved) {
  obj.props.clear();
  for (const [k, v, rv] of saved) { if (v instanceof Ref) v.v = rv; obj.props.set(k, v); }
}
function initGhost(obj, lz) {
  const saved = lazySnapshot(obj);
  // the lazy properties start out with their default values
  for (const key of lz.keys) {
    if (obj.props.has(key)) continue;
    const info = obj.cls.slots.get(key);
    if (info === undefined) continue;
    if (info.hasDef) { const v = propDefault(info); if (v !== null && typeof v === 'object' && 'cow' in v) v.cow = true; obj.props.set(key, v); }
    else if (!info.type) obj.props.set(key, null);
  }
  obj.lazy = undefined;
  lazyRunning.add(obj);
  let r;
  try { r = callValue(lz.init, [obj]); }
  catch (e) { lazyRestore(obj, saved); obj.lazy = lz; throw e; }
  finally { lazyRunning.delete(obj); }
  if (r !== null && r !== undefined) {
    lazyRestore(obj, saved); obj.lazy = lz;
    throwError('TypeError', 'Lazy object initializer must return NULL or no value');
  }
  return obj;
}
function initProxy(obj, lz) {
  obj.lazy = undefined;
  lazyRunning.add(obj);
  let r;
  try { r = callValue(lz.init, [obj]); } finally { obj.lazy = lz; lazyRunning.delete(obj); }
  if (!(r instanceof PHPObject)) throwError('TypeError', `Lazy proxy factory must return an instance of a class compatible with ${obj.cls.name}, ${typeOf(r)} returned`);
  if (r.lazy !== undefined) throwError('Error', 'Lazy proxy factory must return a non-lazy object');
  if (!proxyCompatible(obj.cls, r.cls)) throwError('TypeError', `The real instance class ${r.cls.name} is not compatible with the proxy class ${obj.cls.name}. The proxy must be a instance of the same class as the real instance, or a sub-class with no additional properties, and no overrides of the __destructor or __clone methods.`);
  if (lz.instance !== null) return lz.instance; // (the factory initialized the proxy itself)
  lz.instance = r; lz.init = null;
  // the proxy's own properties are dropped: from now on, accesses go to the instance's
  const keys = new Set();
  for (const [key, info] of r.cls.slots) if (!info.virtual) keys.add(key);
  for (const key of [...obj.props.keys()]) if (keys.has(key) || !obj.cls.slots.has(key)) obj.props.delete(key);
  lz.keys = keys;
  return r;
}
function proxyCompatible(p, c) {
  if (p === c) return true;
  if (!p.ancestors.has(c.lname)) return false;
  for (const [key, info] of p.slots) if (!info.virtual && !c.slots.has(key)) return false;
  for (const m of ['__destruct', '__clone']) { const a = p.methods.get(m), b = c.methods.get(m); if ((a && a.fn) !== (b && b.fn)) return false; }
  return true;
}
// a lazy property now has a value of its own (skipLazyInitialization() and the like); the object
// is no longer lazy once all of them do
export function lazyRealize(obj, key) {
  const lz = obj.lazy;
  if (lz === undefined || lz.instance !== null) return;
  lz.keys.delete(key);
  if (lz.keys.size === 0) obj.lazy = undefined;
}
