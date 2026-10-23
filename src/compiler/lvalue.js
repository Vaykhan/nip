// Compilation of assignable expressions (variables, $a[...], properties, static props, list()).

import { cp, NOREF, normKey, PHPArray, PHPObject, Ref } from '../values.js';
import { toBool, toStr, typeOf } from '../convert.js';
import {
  isLvalNode, keyRepr, readIndex, strOffsetChar, strSetOffset, SUPERGLOBALS, warnUndefVar,
  writableArrIn
} from './common.js';
import { cExpr } from './expr.js';
import { rt } from '../runtime/state.js';
import { deprecated, notice, throwError, warn } from '../runtime/errors.js';
import { coercePropType } from '../runtime/functions.js';
import {
  bindProp, callMethodName, findStaticProp, lookupClass, lookupStaticProp, propArr, propRef, readProp,
  readPropQuiet, unsetProp, writeProp
} from '../runtime/classes.js';
import { dropRef, gcCheck } from '../runtime/gc.js';

export function cLval(n) {
  switch (n.k) {
    case 'Var': return typeof n.name === 'string' ? lvVar(n.name, n) : lvVarVar({ k: 'VarVar', e: n.name }, n);
    case 'VarVar': return lvVarVar(n);
    case 'Index': return lvIndex(n);
    case 'Prop': return lvProp(n);
    case 'SProp': return lvSProp(n);
    case 'List': return lvList(n);
    case 'Paren': return cLval(n.e);
  }
  return lvTemp(n);
}

function lvTemp(n) {
  const E = cExpr(n);
  const bad = () => throwError('Error', 'Cannot use temporary expression in write context');
  return {
    get: E, getq: E, set: bad, bind: bad, unset: bad,
    ref: (f) => new Ref(E(f)),
    arr: (f) => { const v = E(f); if (v instanceof PHPObject) return v; if (v instanceof PHPArray) return v.clone(); bad(); },
    modify: bad, temp: true,
  };
}

function lvVar(name, node) {
  if (name === 'this') {
    const get = (f) => { if (!f.this) throwError('Error', 'Using $this when not in object context'); return f.this; };
    const bad = () => throwError('Error', 'Cannot re-assign $this');
    return { get, getq: (f) => f.this || undefined, set: bad, bind: bad, ref: (f) => new Ref(get(f)), arr: get, unset: () => throwError('Error', 'Cannot unset $this'), modify: bad };
  }
  if (name === 'GLOBALS') {
    const get = () => globalsArray();
    const bad = () => throwError('Error', 'Cannot re-assign $GLOBALS');
    return { get, getq: get, set: bad, bind: bad, ref: (f) => new Ref(get()), arr: () => globalsProxy, unset: bad, modify: bad, globals: true };
  }
  if (SUPERGLOBALS.has(name)) {
    const R = () => rt.globals[name] || (rt.globals[name] = new Ref(new PHPArray()));
    return {
      get: () => R().v, getq: () => R().v, set: (f, v) => { R().v = v; }, bind: (f, r) => { rt.globals[name] = r; },
      ref: R, arr: () => writableArrIn(R()), unset: () => { delete rt.globals[name]; },
      modify: (f, fn) => { const r = R(); return (r.v = fn(r.v)); },
    };
  }
  return {
    name,
    get(f) { const r = f.vars[name]; if (r === undefined) { warnUndefVar(name); return null; } return r.v; },
    getq(f) { const r = f.vars[name]; return r === undefined ? undefined : r.v; },
    set(f, v) { const r = f.vars[name]; if (r !== undefined) { const old = r.v; r.v = v; if (old !== v && old !== null && typeof old === 'object') { dropRef(old); if (old instanceof PHPObject && old.cls.hasDestructor) gcCheck(old); } } else f.vars[name] = new Ref(v); },
    bind(f, ref) { const old = f.vars[name]; f.vars[name] = ref; if (old !== undefined && old !== ref && old.v !== null && typeof old.v === 'object') dropRef(old.v); },
    ref(f) { return f.vars[name] || (f.vars[name] = new Ref(null)); },
    arr(f) {
      const r = f.vars[name] || (f.vars[name] = new Ref(null));
      const v = r.v;
      if (v instanceof PHPArray && !v.cow && !v.fe) return v;
      return writableArrIn(r);
    },
    unset(f) { const r = f.vars[name]; delete f.vars[name]; if (r !== undefined) { dropRef(r.v); if (r.v instanceof PHPObject && r.v.cls.hasDestructor) gcCheck(r.v); } },
    place() { return this; },
    modify(f, fn, quiet) {
      let r = f.vars[name];
      if (r === undefined) { if (!quiet) warnUndefVar(name); r = f.vars[name] = new Ref(null); }
      return (r.v = fn(r.v));
    },
  };
}

function lvVarVar(n) {
  const E = cExpr(n.e);
  const nm = (f) => toStr(E(f));
  const sub = (f) => lvVarDyn(nm(f));
  return {
    place: (f) => lvVarDyn(nm(f)),
    get: (f) => sub(f).get(f), getq: (f) => sub(f).getq(f), set: (f, v) => sub(f).set(f, v), bind: (f, r) => sub(f).bind(f, r),
    ref: (f) => sub(f).ref(f), arr: (f) => sub(f).arr(f), unset: (f) => sub(f).unset(f), modify: (f, fn, q) => sub(f).modify(f, fn, q),
  };
}
export const lvVarCache = new Map();
function lvVarDyn(name) { let l = lvVarCache.get(name); if (!l) { l = lvVar(name); lvVarCache.set(name, l); } return l; }

// $GLOBALS support
function globalsArray() {
  const a = new PHPArray();
  for (const k of Object.keys(rt.globals)) a.set(normKey(k), cp(rt.globals[k].v));
  return a;
}
const globalsProxy = { isGlobalsProxy: true };

function lvIndex(n) {
  const P = isLvalNode(n.o) ? cLval(n.o) : lvTemp(n.o);
  const I = n.i ? cExpr(n.i) : null;
  if (P.globals) {
    const gref = (f) => { const k = toStr(I(f)); return rt.globals[k] || (rt.globals[k] = new Ref(null)); };
    return {
      get: (f) => { const k = toStr(I(f)); const r = rt.globals[k]; if (!r) { warn(`Undefined global variable $${k}`); return null; } return r.v; },
      getq: (f) => { const r = rt.globals[toStr(I(f))]; return r ? r.v : undefined; },
      set: (f, v) => { const g = gref(f); const old = g.v; g.v = v; if (old !== v) dropRef(old); },
      bind: (f, r) => { const k = toStr(I(f)); const old = rt.globals[k]; rt.globals[k] = r; if (old && old !== r) dropRef(old.v); }, ref: gref,
      arr: (f) => writableArrIn(gref(f)), unset: (f) => { const k = toStr(I(f)); const old = rt.globals[k]; delete rt.globals[k]; if (old) dropRef(old.v); },
      modify: (f, fn) => { const r = gref(f); return (r.v = fn(r.v)); },
    };
  }
  const lv = indexOps(P, I);
  lv.place = (f) => {
    // pre-evaluate base sub-expressions and the key (PHP evaluates dims before the assigned value)
    const bp = P.place ? P.place(f) : constPlace(P.get(f));
    const key = I ? I(f) : undefined;
    return indexOps(bp, I ? () => key : null);
  };
  return lv;
}
function constPlace(v) {
  const bad = () => throwError('Error', 'Cannot use temporary expression in write context');
  return { get: () => v, getq: () => v, set: bad, bind: bad, unset: bad, ref: () => new Ref(v), arr: () => { if (v instanceof PHPObject) return v; if (v instanceof PHPArray) return v.clone(); bad(); }, modify: bad, temp: true };
}
function indexOps(P, I) {
  const noIdx = () => throwError('Error', 'Cannot use [] for reading');
  const lv = {
    get(f) {
      const base = P.get(f);
      if (!I) noIdx();
      const key = I(f);
      if (base instanceof PHPArray) {
        const k = typeof key === 'number' ? key : normKey(key);
        const i = base.index(k);
        if (i === undefined) { warn(`Undefined array key ${keyRepr(k)}`); return null; }
        const v = base.v[i];
        return v instanceof Ref ? v.v : v;
      }
      return readIndex(base, key, false);
    },
    getq(f) {
      const base = P.getq(f);
      if (base === undefined || base === null) return undefined;
      if (!I) noIdx();
      return readIndex(base, I(f), true);
    },
    peek(f) {
      const b = P.peek ? P.peek(f) : P.getq(f);
      if (b instanceof PHPArray) return readIndex(b, I ? I(f) : null, true);
      if (typeof b === 'string') return b;
      return undefined;
    },
    set(f, v) {
      if (!P.temp) {
        const cur = P.peek ? P.peek(f) : P.getq(f);
        if (typeof cur === 'string' && cur !== '') {
          if (!I) throwError('Error', '[] operator not supported for strings');
          P.set(f, strSetOffset(cur, I(f), v));
          return strOffsetChar;
        }
      }
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        if (I) { const k = normKey(I(f)); const old = c.get(k); c.set(k, v); if (old !== v && old !== null && typeof old === 'object') dropRef(old); } else c.push(v);
        return;
      }
      if (c instanceof PHPObject) { arrayAccessSet(c, I ? I(f) : null, v); return; }
    },
    bind(f, ref) {
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        if (I) { const k = normKey(I(f)); const old = c.getRaw(k); c.setRaw(k, ref); if (old !== undefined && old !== ref) dropRef(old instanceof Ref ? old.v : old); } else c.push(ref);
        return;
      }
      throwError('Error', 'Cannot assign by reference to overloaded object');
    },
    ref(f) {
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        let k;
        if (I) k = normKey(I(f)); else { k = c.nextKey(); c.push(null); }
        const slot = c.getRaw(k);
        if (slot instanceof Ref) return slot;
        const r = new Ref(slot === undefined ? null : slot);
        c.setRaw(k, r);
        return r;
      }
      if (c instanceof PHPObject) {
        rt.lastRetRef = null;
        const v = arrayAccessGet(c, I ? I(f) : null);
        const rr = rt.lastRetRef; rt.lastRetRef = null;
        if (rr !== null && rr !== NOREF) return rr;
        notice(`Indirect modification of overloaded element of ${c.cls.name} has no effect`);
        return new Ref(v);
      }
      return new Ref(null);
    },
    arr(f) {
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        if (!I) { const na = new PHPArray(); c.push(na); return na; }
        const k = normKey(I(f));
        const slot = c.getRaw(k);
        let v = slot instanceof Ref ? slot.v : slot;
        if (v instanceof PHPArray) {
          if (v.cow || v.fe) { v = v.clone(); if (slot instanceof Ref) slot.v = v; else c.setRaw(k, v); }
          return v;
        }
        if (v === null || v === undefined) { const na = new PHPArray(); if (slot instanceof Ref) slot.v = na; else c.setRaw(k, na); return na; }
        if (v instanceof PHPObject) return v;
        if (v === false) { deprecated('Automatic conversion of false to array is deprecated'); const na = new PHPArray(); if (slot instanceof Ref) slot.v = na; else c.setRaw(k, na); return na; }
        if (typeof v === 'string') { if (v === '') { const na = new PHPArray(); c.setRaw(k, na); return na; } throwError('Error', 'Cannot use assign-op operators with string offsets'); }
        throwError('Error', 'Cannot use a scalar value as an array');
      }
      if (c instanceof PHPObject) {
        rt.lastRetRef = null;
        const v = arrayAccessGet(c, I ? I(f) : null);
        const rr = rt.lastRetRef; rt.lastRetRef = null;
        if (v instanceof PHPObject) return v;
        if (rr !== null && rr !== NOREF) return writableArrIn(rr);
        notice(`Indirect modification of overloaded element of ${c.cls.name} has no effect`);
        return v instanceof PHPArray ? v.clone() : new PHPArray();
      }
    },
    unset(f) {
      const cur = P.getq(f);
      if (cur === undefined || cur === null) return;
      if (cur instanceof PHPArray) { const c = P.arr(f); const k = normKey(I(f)); const old = c.get(k); c.delete(k); dropRef(old); gcCheck(old); return; }
      if (cur instanceof PHPObject) { if (cur.cls.ancestors.has('arrayaccess')) callMethodName(cur, 'offsetUnset', [I(f)]); else throwError('Error', `Cannot use object of type ${cur.cls.name} as array`); return; }
      if (typeof cur === 'string') throwError('Error', 'Cannot unset string offsets');
    },
    modify(f, fn, quiet) {
      if (!P.temp) {
        const cur = P.getq(f);
        if (typeof cur === 'string' && cur !== '') {
          const key = I(f);
          const nv = fn(readIndex(cur, key, quiet));
          P.set(f, strSetOffset(cur, key, nv));
          return nv;
        }
      }
      const c = P.arr(f);
      if (c instanceof PHPArray) {
        let k;
        if (I) k = normKey(I(f));
        else { const nv = fn(null); c.push(nv); return nv; }
        const i = c.index(k);
        let cur;
        if (i === undefined) { if (!quiet) warn(`Undefined array key ${keyRepr(k)}`); cur = null; }
        else { cur = c.v[i]; if (cur instanceof Ref) cur = cur.v; }
        const nv = fn(cur);
        c.set(k, nv);
        return nv;
      }
      if (c instanceof PHPObject) {
        const key = I ? I(f) : null;
        const nv = fn(quiet ? (toBool(callMethodName(c, 'offsetExists', [key])) ? arrayAccessGet(c, key) : null) : arrayAccessGet(c, key));
        arrayAccessSet(c, key, nv);
        return nv;
      }
    },
  };
  return lv;
}

function arrayAccessGet(o, k) {
  if (!o.cls.ancestors.has('arrayaccess')) throwError('Error', `Cannot use object of type ${o.cls.name} as array`);
  return callMethodName(o, 'offsetGet', [k]);
}
function arrayAccessSet(o, k, v) {
  if (!o.cls.ancestors.has('arrayaccess')) throwError('Error', `Cannot use object of type ${o.cls.name} as array`);
  callMethodName(o, 'offsetSet', [k, v]);
}

function lvProp(n) {
  const O = isLvalNode(n.o) ? cLval(n.o) : lvTemp(n.o);
  const N = typeof n.name === 'string' ? null : cExpr(n.name);
  const lv = propOps(O, N, typeof n.name === 'string' ? n.name : null, n.nullsafe);
  lv.place = (f) => {
    const op = O.place ? O.place(f) : constPlace(O.get(f));
    const name = N ? toStr(N(f)) : null;
    return propOps(op, null, N ? name : n.name, n.nullsafe);
  };
  return lv;
}
function propOps(O, N, sname, nullsafe) {
  const nm = N ? (f) => toStr(N(f)) : () => sname;
  const objW = (f, name) => {
    const o = O.get(f);
    if (o instanceof PHPObject) return o;
    if (o === null || o === undefined) throwError('Error', `Attempt to assign property "${name}" on null`);
    throwError('Error', `Attempt to assign property "${name}" on ${typeOf(o)}`);
  };
  return {
    get(f) {
      const o = O.get(f);
      if (o instanceof PHPObject) return readProp(o, nm(f), f);
      if ((o === null || o === undefined)) { if (nullsafe) return null; warn(`Attempt to read property "${nm(f)}" on null`); return null; }
      warn(`Attempt to read property "${nm(f)}" on ${typeOf(o)}`); return null;
    },
    getq(f) {
      const o = O.getq(f);
      if (o instanceof PHPObject) return readPropQuiet(o, nm(f), f);
      return undefined;
    },
    isset(f) {
      const o = O.getq(f);
      if (o instanceof PHPObject) return readPropQuiet(o, nm(f), f, true);
      return undefined;
    },
    set(f, v) { const name = nm(f); writeProp(objW(f, name), name, v, f); },
    bind(f, ref) { const name = nm(f); const o = objW(f, name); bindProp(o, name, ref, f); },
    ref(f) { const name = nm(f); return propRef(objW(f, name), name, f); },
    arr(f) {
      const name = nm(f);
      const o = O.get(f);
      if (!(o instanceof PHPObject)) {
        if (o === null || o === undefined) throwError('Error', `Attempt to modify property "${name}" on null`);
        throwError('Error', `Attempt to modify property "${name}" on ${typeOf(o)}`);
      }
      return propArr(o, name, f);
    },
    unset(f) { const o = O.getq(f); if (o instanceof PHPObject) unsetProp(o, nm(f), f); },
    modify(f, fn, quiet) {
      const name = nm(f);
      const o = objW(f, name);
      const cur = quiet ? readPropQuiet(o, name, f) : readProp(o, name, f);
      const nv = fn(cur === undefined ? null : cur);
      writeProp(o, name, nv, f);
      return nv;
    },
  };
}

function lvSProp(n) {
  const C = cClassRef(n.cls);
  const N = typeof n.name === 'string' ? null : cExpr(n.name.k === 'VarVar' ? n.name.e : n.name);
  const lv = spropOps(C, N, n.name);
  lv.place = (f) => { const cls = C(f); const name = N ? toStr(N(f)) : n.name; return spropOps(() => cls, null, name); };
  return lv;
}
function spropOps(C, N, sname) {
  const n = { name: sname };
  const nm = N ? (f) => toStr(N(f)) : () => n.name;
  const info = (f) => findStaticProp(C(f), nm(f), f);
  return {
    get: (f) => info(f).ref.v,
    getq: (f) => { const cls = C(f); const i = lookupStaticProp(cls, nm(f)); return i ? i.ref.v : undefined; },
    set: (f, v) => { const i = info(f); i.ref.v = i.type ? coercePropType(i, v, i.cls.name, nm(f)) : v; },
    bind: (f, r) => { info(f).ref = r; },
    ref: (f) => info(f).ref,
    arr: (f) => writableArrIn(info(f).ref),
    unset: () => throwError('Error', 'Attempt to unset static property'),
    modify: (f, fn) => { const i = info(f); const nv = fn(i.ref.v); i.ref.v = i.type ? coercePropType(i, nv, i.cls.name, nm(f)) : nv; return nv; },
  };
}

function lvList(n) {
  const items = n.items.map((it) => {
    if (!it) return null;
    return { K: it.key ? cExpr(it.key) : null, L: cLval(it.v), byRef: it.byRef };
  });
  const assign = (f, v, srcLv) => {
    let idx = 0;
    for (const it of items) {
      if (!it) { idx++; continue; }
      const key = it.K ? it.K(f) : idx++;
      if (it.byRef) {
        if (!srcLv) throwError('Error', 'Cannot assign reference to non referenceable value');
        if (typeof v === 'string' && v !== '') throwError('Error', 'Cannot create references to/from string offsets');
        const c = srcLv.arr(f);
        if (c instanceof PHPObject) {
          if (!c.cls.ancestors.has('arrayaccess')) throwError('Error', `Cannot use object of type ${c.cls.name} as array`);
          const val = callMethodName(c, 'offsetGet', [key]);
          notice(`Indirect modification of overloaded element of ${c.cls.name} has no effect`);
          it.L.bind(f, new Ref(cp(val)));
          continue;
        }
        const k = normKey(key);
        let slot = c.getRaw(k);
        if (!(slot instanceof Ref)) { slot = new Ref(slot === undefined ? null : slot); c.setRaw(k, slot); }
        it.L.bind(f, slot);
        continue;
      }
      let val;
      if (v instanceof PHPArray) {
        const k = normKey(key);
        if (!v.has(k)) { warn(`Undefined array key ${keyRepr(k)}`); val = null; }
        else val = v.get(k);
      } else if (v instanceof PHPObject && v.cls.ancestors.has('arrayaccess')) val = callMethodName(v, 'offsetGet', [key]);
      else val = null;
      if (it.L.listAssign) it.L.listAssign(f, val, null);
      else it.L.set(f, cp(val));
    }
  };
  const bad = () => throwError('Error', 'Cannot use list() in this context');
  return { listAssign: assign, set: (f, v) => assign(f, v, null), get: bad, getq: bad, ref: bad, bind: bad, arr: bad, unset: bad, modify: bad, hasRef: items.some((it) => it && it.byRef) };
}

// class reference: string name | 'self' | 'parent' | 'static' | expression
export function cClassRef(c) {
  if (typeof c === 'string') {
    const lc = c.toLowerCase();
    if (lc === 'self') return (f) => { if (!f.cls) throwError('Error', 'Cannot use "self" when no class scope is active'); return f.cls; };
    if (lc === 'static') return (f) => { if (!f.sc) throwError('Error', 'Cannot use "static" when no class scope is active'); return f.sc; };
    if (lc === 'parent') return (f) => {
      if (!f.cls) throwError('Error', 'Cannot use "parent" when no class scope is active');
      if (!f.cls.parent) throwError('Error', 'Cannot use "parent" when current class scope has no parent');
      return f.cls.parent;
    };
    let cached = null, cachedEpoch = -1; // see compileNamedCall
    return () => {
      if (cachedEpoch !== rt.epoch || !cached) { cached = lookupClass(c); cachedEpoch = rt.epoch; }
      return cached;
    };
  }
  const E = cExpr(c);
  return (f) => {
    const v = E(f);
    if (v instanceof PHPObject) return v.cls;
    if (typeof v === 'string') return lookupClass(v);
    throwError('Error', 'Class name must be a valid object or a string');
  };
}
