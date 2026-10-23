// serialize / unserialize.

import { Flt, fmtRepr, mkf, normKey, numFromText, PHPArray, PHPObject, Ref } from '../values.js';
import { toStr } from '../convert.js';
import { rt } from '../runtime/state.js';
import { throwError, warn } from '../runtime/errors.js';
import { callMethodName, classConst, classExists, initProps, lookupClass, objectProps } from '../runtime/classes.js';
import { def, S } from './core.js';
import { JsonErr } from './json.js';
import { closureClass } from '../runtime/native-classes.js';

function serializeVal(v, seen) {
  if (v instanceof Ref) v = v.v;
  if (v === null || v === undefined) return 'N;';
  switch (typeof v) {
    case 'boolean': return `b:${v ? 1 : 0};`;
    case 'number': case 'bigint': return `i:${v};`;
    case 'string': return `s:${v.length}:"${v}";`;
  }
  if (v instanceof Flt) return `d:${fmtRepr(v.v)};`;
  if (v instanceof PHPArray) {
    let s = `a:${v.size}:{`;
    for (const [k, x] of v.entries()) s += serializeVal(k, seen) + serializeVal(x, seen);
    return s + '}';
  }
  if (v instanceof PHPObject) {
    const cn = v.cls.name;
    if (v.cls.isEnum) { const t = cn + ':' + v.props.get('name'); return `E:${t.length}:"${t}";`; }
    if (v.cls === closureClass) throwError('Exception', "Serialization of 'Closure' is not allowed");
    if (v.cls.methods.has('__serialize')) {
      const data = callMethodName(v, '__serialize', []);
      if (!(data instanceof PHPArray)) throwError('TypeError', `${cn}::__serialize() must return an array`);
      let s = `O:${cn.length}:"${cn}":${data.size}:{`;
      for (const [k, x] of data.entries()) s += serializeVal(k, seen) + serializeVal(x, seen);
      return s + '}';
    }
    if (v.cls.ancestors.has('serializable')) {
      const d = callMethodName(v, 'serialize', []);
      if (d === null) return 'N;';
      const ds = toStr(d);
      return `C:${cn.length}:"${cn}":${ds.length}:{${ds}}`;
    }
    let keys = null;
    if (v.cls.methods.has('__sleep')) {
      const r = callMethodName(v, '__sleep', []);
      keys = r instanceof PHPArray ? r.values().map(toStr) : [];
    }
    const entries = [];
    for (const [k, x] of objectProps(v)) {
      let sk = k;
      const plain = k.charCodeAt(0) === 0 ? k.slice(k.indexOf('\0', 1) + 1) : k;
      if (keys && !keys.includes(plain)) continue;
      const info = v.cls.props.get(k);
      if (info && info.vis === 'protected') sk = '\0*\0' + k;
      entries.push([sk, x]);
    }
    let s = `O:${cn.length}:"${cn}":${entries.length}:{`;
    for (const [k, x] of entries) s += serializeVal(k, seen) + serializeVal(x, seen);
    return s + '}';
  }
  return 'i:0;';
}
def('serialize', (value) => serializeVal(value, new Set()));
function unserializeVal(s, opts) {
  let i = 0;
  const vals = [];
  const fail = () => { throw new JsonErr(i); };
  const readUntil = (ch) => { const j = s.indexOf(ch, i); if (j < 0) fail(); const r = s.slice(i, j); i = j + 1; return r; };
  const val = () => {
    const t = s[i];
    if (s[i + 1] !== ':' && t !== 'N') fail();
    switch (t) {
      case 'N': i += 2; vals.push(null); return null;
      case 'b': { i += 2; const r = readUntil(';') === '1'; vals.push(r); return r; }
      case 'i': { i += 2; const r = numFromText(readUntil(';')); vals.push(r); return r; }
      case 'd': { i += 2; const t2 = readUntil(';'); const r = mkf(t2 === 'INF' ? Infinity : t2 === '-INF' ? -Infinity : t2 === 'NAN' ? NaN : Number(t2)); vals.push(r); return r; }
      case 's': {
        i += 2; const len = parseInt(readUntil(':'), 10);
        if (s[i] !== '"') fail();
        const r = s.substr(i + 1, len); if (r.length !== len || s[i + 1 + len] !== '"') fail();
        i += len + 3; vals.push(r); return r;
      }
      case 'a': {
        i += 2; const n = parseInt(readUntil(':'), 10);
        if (s[i] !== '{') fail(); i++;
        const a = new PHPArray(); vals.push(a);
        for (let k = 0; k < n; k++) { const key = keyVal(); a.set(normKey(key), val()); }
        if (s[i] !== '}') fail(); i++;
        return a;
      }
      case 'E': {
        i += 2; const len = parseInt(readUntil(':'), 10);
        const t2 = s.substr(i + 1, len); i += len + 3;
        const [cn, cs] = t2.split(':');
        const cls = lookupClass(cn);
        const r = classConst(cls, cs);
        vals.push(r); return r;
      }
      case 'O': case 'C': {
        i += 2; const len = parseInt(readUntil(':'), 10);
        const cn = s.substr(i + 1, len); i += len + 3;
        let cls = classExists(cn, true);
        const allowed = opts.allowed;
        if (allowed === false || (Array.isArray(allowed) && !allowed.includes(cn.toLowerCase()))) cls = rt.classes.get('__php_incomplete_class');
        if (!cls) { cls = rt.classes.get('__php_incomplete_class'); }
        const obj = new PHPObject(cls);
        vals.push(obj);
        if (t === 'C') {
          const dl = parseInt(readUntil(':'), 10);
          const data = s.substr(i + 1, dl); i += dl + 2;
          initProps(obj);
          callMethodName(obj, 'unserialize', [data]);
          return obj;
        }
        const n = parseInt(readUntil(':'), 10);
        if (s[i] !== '{') fail(); i++;
        const data = new PHPArray();
        for (let k = 0; k < n; k++) { const key = keyVal(); data.set(normKey(key), val()); }
        if (s[i] !== '}') fail(); i++;
        if (cls.lname === '__php_incomplete_class') obj.props.set('__PHP_Incomplete_Class_Name', cn);
        if (cls.methods.has('__unserialize')) { initProps(obj); callMethodName(obj, '__unserialize', [data]); }
        else {
          initProps(obj);
          for (const [k, x] of data.entries()) {
            let key = String(k);
            if (key.startsWith('\0*\0')) key = key.slice(3);
            obj.props.set(key, x);
          }
          if (cls.methods.has('__wakeup')) callMethodName(obj, '__wakeup', []);
        }
        return obj;
      }
      case 'r': case 'R': { i += 2; const n = parseInt(readUntil(';'), 10); const r = vals[n - 1]; vals.push(r); return r === undefined ? null : r; }
    }
    fail();
  };
  const keyVal = () => { const n = vals.length; const k = val(); vals.length = n; return k; };
  const r = val();
  return [r, i];
}
def('unserialize', (data, options = null) => {
  const s = S(data);
  const opts = {};
  if (options instanceof PHPArray && options.has('allowed_classes')) {
    const ac = options.get('allowed_classes');
    opts.allowed = ac === true ? true : ac instanceof PHPArray ? ac.values().map((x) => toStr(x).toLowerCase()) : false;
  }
  try {
    const [r] = unserializeVal(s, opts);
    return r;
  } catch (e) {
    if (!(e instanceof JsonErr)) throw e;
    if (s !== 'b:0;') warn(`unserialize(): Error at offset ${e.code} of ${s.length} bytes`);
    return false;
  }
});
