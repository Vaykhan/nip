// Type juggling: PHP conversions between values (to string/int/float/bool, numeric strings).

import {
  Flt, fmtFloat, MAXS, normBig, NUM_LEAD, numFromText, PHPArray, PHPObject, PHPResource, Ref
} from './values.js';
import { rt } from './runtime/state.js';
import { throwError, warn } from './runtime/errors.js';
import { findMethod } from './runtime/callables.js';
import { callMethod, displayName } from './runtime/classes.js';

export function typeOf(v) { // get_debug_type
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'boolean': return 'bool';
    case 'number': case 'bigint': return 'int';
    case 'string': return 'string';
  }
  if (v instanceof Flt) return 'float';
  if (v instanceof PHPArray) return 'array';
  if (v instanceof PHPObject) return v.cls.anon ? displayName(v.cls) : v.cls.name;
  if (v instanceof PHPResource) return 'resource (' + v.type + ')';
  if (v instanceof Ref) return typeOf(v.v);
  return 'mixed';
}
export function gettype(v) {
  if (v === null || v === undefined) return 'NULL';
  switch (typeof v) {
    case 'boolean': return 'boolean';
    case 'number': case 'bigint': return 'integer';
    case 'string': return 'string';
  }
  if (v instanceof Flt) return 'double';
  if (v instanceof PHPArray) return 'array';
  if (v instanceof PHPObject) return 'object';
  if (v instanceof PHPResource) return v.closed ? 'resource (closed)' : 'resource';
  return 'unknown type';
}

export function toBool(v) {
  switch (typeof v) {
    case 'boolean': return v;
    case 'number': return v !== 0;
    case 'bigint': return v !== 0n;
    case 'string': return v !== '' && v !== '0';
  }
  if (v === null || v === undefined) return false;
  if (v instanceof Flt) return v.v !== 0;
  if (v instanceof PHPArray) return v.size > 0;
  if (v instanceof PHPObject && v.cls.toBoolHook) return v.cls.toBoolHook(v);
  return true;
}

export function floatToInt(x) {
  if (!isFinite(x)) return 0;
  x = Math.trunc(x);
  if (x <= MAXS && x >= -MAXS) return x === 0 ? 0 : x;
  if (x >= 9223372036854775808 || x < -9223372036854775808) {
    // PHP 8 on 64-bit: out-of-range is UB; modern PHP returns wrapped value. Emulate modular arithmetic.
    return normBig(BigInt.asIntN(64, BigInt(x)));
  }
  return normBig(BigInt(x));
}

export function toInt(v) {
  switch (typeof v) {
    case 'number': case 'bigint': return v;
    case 'boolean': return v ? 1 : 0;
    case 'string': {
      const m = NUM_LEAD.exec(v);
      if (!m) return 0;
      const n = numFromText(m[0]);
      return n instanceof Flt ? floatToInt(n.v) : n;
    }
  }
  if (v === null || v === undefined) return 0;
  if (v instanceof Flt) return floatToInt(v.v);
  if (v instanceof PHPArray) return v.size ? 1 : 0;
  if (v instanceof PHPResource) return v.id;
  if (v instanceof PHPObject) { warn(`Object of class ${v.cls.name} could not be converted to int`); return 1; }
  return 0;
}
export function toDbl(v) { // JS number
  switch (typeof v) {
    case 'number': return v;
    case 'bigint': return Number(v);
    case 'boolean': return v ? 1 : 0;
    case 'string': { const m = NUM_LEAD.exec(v); return m ? Number(m[0].trim()) : 0; }
  }
  if (v === null || v === undefined) return 0;
  if (v instanceof Flt) return v.v;
  if (v instanceof PHPArray) return v.size ? 1 : 0;
  if (v instanceof PHPResource) return v.id;
  if (v instanceof PHPObject) { warn(`Object of class ${v.cls.name} could not be converted to float`); return 1; }
  return 0;
}
// numeric value (int or Flt) for numeric contexts; does not warn
export function toNumber(v) {
  switch (typeof v) {
    case 'number': case 'bigint': return v;
    case 'boolean': return v ? 1 : 0;
    case 'string': { const m = NUM_LEAD.exec(v); return m ? numFromText(m[0]) : 0; }
  }
  if (v === null || v === undefined) return 0;
  if (v instanceof Flt) return v;
  return toInt(v);
}

export function toStr(v) {
  switch (typeof v) {
    case 'string': return v;
    case 'number': return v === 0 ? '0' : String(v);
    case 'bigint': return v.toString();
    case 'boolean': return v ? '1' : '';
  }
  if (v === null || v === undefined) return '';
  if (v instanceof Flt) return fmtFloat(v.v, rt.precision);
  if (v instanceof PHPArray) { warn('Array to string conversion'); return 'Array'; }
  if (v instanceof PHPObject) return objToString(v);
  if (v instanceof PHPResource) return 'Resource id #' + v.id;
  if (v instanceof Ref) return toStr(v.v);
  return String(v);
}
function objToString(o) {
  const m = findMethod(o.cls, '__tostring');
  if (m) { const r = callMethod(o, m, []); if (typeof r !== 'string') throwError('Error', `${o.cls.name}::__toString(): Return value must be of type string, ${typeOf(r)} returned`); return r; }
  throwError('Error', `Object of class ${o.cls.name} could not be converted to string`);
}
