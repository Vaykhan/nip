// Comparison: loose (==) and strict (===) equality, <=> ordering of PHP values.

import { Flt, numericStr, PHPArray, PHPObject, PHPResource, Ref } from './values.js';
import { toBool, toInt, toNumber, toStr } from './convert.js';
import { findMethod } from './runtime/callables.js';
import { closureClass } from './runtime/native-classes.js';

export function numCmp(a, b) { // a, b are int or Flt
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if (!(a instanceof Flt) && !(b instanceof Flt)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  }
  const x = a instanceof Flt ? a.v : Number(a), y = b instanceof Flt ? b.v : Number(b);
  return x < y ? -1 : x > y ? 1 : x === y ? 0 : 1; // NaN: uncomparable
}
function numEq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (!(a instanceof Flt) && !(b instanceof Flt)) return BigInt(a) === BigInt(b);
  const x = a instanceof Flt ? a.v : Number(a), y = b instanceof Flt ? b.v : Number(b);
  return x === y;
}
export function isNum(v) { return typeof v === 'number' || typeof v === 'bigint' || v instanceof Flt; }

export function strCmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export function looseEq(a, b) {
  if (a === b) return !(a instanceof Flt && a.v !== a.v);
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a === b;
  if (ta === 'string' && tb === 'string') {
    const na = numericStr(a); if (na === null) return false;
    const nb = numericStr(b); if (nb === null) return false;
    return numEq(na, nb);
  }
  if (ta === 'boolean' || tb === 'boolean') return toBool(a) === toBool(b);
  if (a === null || a === undefined) {
    if (b === null || b === undefined) return true;
    if (tb === 'string') return b === '';
    if (b instanceof PHPObject) return false;
    return !toBool(b);
  }
  if (b === null || b === undefined) return looseEq(b, a);
  if (isNum(a) && isNum(b)) return numEq(a, b);
  if (isNum(a) && tb === 'string') { const nb = numericStr(b); return nb !== null ? numEq(a, nb) : toStr(a) === b; }
  if (ta === 'string' && isNum(b)) return looseEq(b, a);
  if (a instanceof PHPArray && b instanceof PHPArray) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entries()) { if (!b.has(k)) return false; if (!looseEq(v, b.get(k))) return false; }
    return true;
  }
  if (a instanceof PHPObject && b instanceof PHPObject) {
    if (a === b) return true;
    if (a.cls !== b.cls) return false;
    if (a.cls.isEnum || a.cls === closureClass) return false;
    if (a.props.size !== b.props.size) return false;
    for (const [k, v] of a.props) { if (!b.props.has(k)) return false; const w = b.props.get(k); if (!looseEq(v instanceof Ref ? v.v : v, w instanceof Ref ? w.v : w)) return false; }
    return true;
  }
  if (a instanceof PHPObject) {
    if (tb === 'string' && findMethod(a.cls, '__tostring')) return toStr(a) === b;
    if (isNum(b)) { if (a.cls.isEnum) return false; return numEq(1, b); }
    return false;
  }
  if (b instanceof PHPObject) return looseEq(b, a);
  if (a instanceof PHPResource || b instanceof PHPResource) return toInt(a) === toInt(b) && (isNum(a) || isNum(b) || (a instanceof PHPResource && b instanceof PHPResource));
  return false;
}

export function strictEq(a, b) {
  if (a === b) return !(a instanceof Flt && a.v !== a.v);
  const ta = typeof a;
  if (ta === 'number' || ta === 'bigint') return (typeof b === 'number' || typeof b === 'bigint') && BigInt(a) === BigInt(b);
  if (a instanceof Flt) return b instanceof Flt && a.v === b.v;
  if (a === undefined) return b === null;
  if (b === undefined) return a === null;
  if (a instanceof PHPArray && b instanceof PHPArray) {
    if (a.size !== b.size) return false;
    const ea = a.entries(), eb = b.entries();
    for (let i = 0; i < ea.length; i++) { if (ea[i][0] !== eb[i][0]) return false; if (!strictEq(ea[i][1], eb[i][1])) return false; }
    return true;
  }
  return false;
}

export function cmp(a, b) { // <=> : -1 0 1
  const ta = typeof a, tb = typeof b;
  if (ta === 'number' && tb === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'string' && tb === 'string') {
    const na = numericStr(a), nb = na === null ? null : numericStr(b);
    if (na !== null && nb !== null) return numCmp(na, nb);
    return strCmp(a, b);
  }
  if (ta === 'boolean' || tb === 'boolean' || a === null || b === null || a === undefined || b === undefined) {
    if ((a === null || a === undefined) && tb === 'string') return strCmp('', b);
    if ((b === null || b === undefined) && ta === 'string') return strCmp(a, '');
    if ((a === null || a === undefined) && b instanceof PHPObject) return -1;
    if ((b === null || b === undefined) && a instanceof PHPObject) return 1;
    const x = toBool(a), y = toBool(b);
    return x === y ? 0 : x ? 1 : -1;
  }
  if (isNum(a) && isNum(b)) return numCmp(a, b);
  if (isNum(a) && tb === 'string') { const nb = numericStr(b); return nb !== null ? numCmp(a, nb) : strCmp(toStr(a), b); }
  if (ta === 'string' && isNum(b)) { const na = numericStr(a); return na !== null ? numCmp(na, b) : strCmp(a, toStr(b)); }
  if (a instanceof PHPArray && b instanceof PHPArray) {
    if (a.size !== b.size) return a.size < b.size ? -1 : 1;
    for (const [k, v] of a.entries()) { if (!b.has(k)) return 1; const c = cmp(v, b.get(k)); if (c) return c; }
    return 0;
  }
  if (a instanceof PHPArray) return 1;
  if (b instanceof PHPArray) return -1;
  if (a instanceof PHPObject && b instanceof PHPObject) {
    if (a === b) return 0;
    if (a.cls !== b.cls) return 1;
    for (const [k, v] of a.props) { if (!b.props.has(k)) return 1; const w = b.props.get(k); const c = cmp(v instanceof Ref ? v.v : v, w instanceof Ref ? w.v : w); if (c) return c; }
    return 0;
  }
  if (a instanceof PHPObject) { if (tb === 'string' && findMethod(a.cls, '__tostring')) return strCmp(toStr(a), b); return 1; }
  if (b instanceof PHPObject) { if (ta === 'string' && findMethod(b.cls, '__tostring')) return strCmp(a, toStr(b)); return -1; }
  return numCmp(toNumber(a), toNumber(b));
}
