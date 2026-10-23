// Variable handling: gettype, is_*, intval/floatval/boolval, settype, ...

import {
  Flt, I64MAX, I64MIN, isInt, mkf, normBig, NUM_FULL, PHPArray, PHPObject, PHPResource, Ref
} from '../values.js';
import { gettype, toBool, toDbl, toInt, toStr, typeOf } from '../convert.js';
import { isNum } from '../compare.js';
import { rt } from '../runtime/state.js';
import { throwError } from '../runtime/errors.js';
import { callableName, isCallable } from '../runtime/callables.js';
import { toArrayCast, toObjectCast } from '../runtime/classes.js';
import { alias, def, I, R1, S } from './core.js';

def('gettype', (value) => gettype(value));
def('get_debug_type', (value) => typeOf(value));
def('is_int', (value) => isInt(value));
alias('is_integer', 'is_int'); alias('is_long', 'is_int');
def('is_float', (value) => value instanceof Flt);
alias('is_double', 'is_float');
def('is_string', (value) => typeof value === 'string');
def('is_bool', (value) => typeof value === 'boolean');
def('is_array', (value) => value instanceof PHPArray);
def('is_object', (value) => value instanceof PHPObject);
def('is_null', (value) => value === null || value === undefined);
def('is_resource', (value) => value instanceof PHPResource && !value.closed);
def('is_numeric', (value) => isNum(value) || (typeof value === 'string' && NUM_FULL.test(value)));
def('is_scalar', (value) => isNum(value) || typeof value === 'string' || typeof value === 'boolean');
def('is_iterable', (value) => value instanceof PHPArray || (value instanceof PHPObject && value.cls.ancestors.has('traversable')));
def('is_countable', (value) => value instanceof PHPArray || (value instanceof PHPObject && value.cls.ancestors.has('countable')));
def('is_callable', (value, syntax_only = false, callable_name = undefined) => {
  if (callable_name instanceof Ref) callable_name.v = callableName(value);
  if (toBool(syntax_only)) return typeof value === 'string' || value instanceof PHPArray || value instanceof PHPObject;
  return isCallable(value, rt.frame);
}, { refs: [false, false, true] });
def('intval', (value, base = 10) => {
  const b = I(base);
  if (typeof value !== 'string' || b === 10) return toInt(value);
  let s = value.trim().toLowerCase(); let neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  let bb = b;
  if (b === 0) { if (s.startsWith('0x')) { bb = 16; s = s.slice(2); } else if (s.startsWith('0b')) { bb = 2; s = s.slice(2); } else if (s.startsWith('0o')) { bb = 8; s = s.slice(2); } else if (s.startsWith('0') && s.length > 1) { bb = 8; s = s.slice(1); } else bb = 10; }
  else if (b === 16 && s.startsWith('0x')) s = s.slice(2);
  else if (b === 2 && s.startsWith('0b')) s = s.slice(2);
  else if (b === 8 && s.startsWith('0o')) s = s.slice(2);
  let r = 0n; const B2 = BigInt(bb);
  for (const ch of s) { const d = parseInt(ch, 36); if (isNaN(d) || d >= bb) break; r = r * B2 + BigInt(d); if (r > I64MAX + 1n) break; }
  if (neg) r = -r;
  if (r > I64MAX) return normBig(I64MAX); if (r < I64MIN) return normBig(I64MIN);
  return normBig(r);
});
def('floatval', (value) => mkf(toDbl(value)));
alias('doubleval', 'floatval');
def('boolval', (value) => toBool(value));
def('settype', (_var, type) => {
  const t = S(type).toLowerCase();
  const v = _var.v;
  switch (t) {
    case 'int': case 'integer': _var.v = toInt(v); break;
    case 'float': case 'double': _var.v = mkf(toDbl(v)); break;
    case 'string': _var.v = toStr(v); break;
    case 'bool': case 'boolean': _var.v = toBool(v); break;
    case 'array': _var.v = toArrayCast(v); break;
    case 'object': _var.v = toObjectCast(v); break;
    case 'null': _var.v = null; break;
    default: throwError('ValueError', 'settype(): Argument #2 ($type) must be a valid type');
  }
  return true;
}, R1);
