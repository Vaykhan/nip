// filter_var and locale stubs.

import { Flt, mkf, numericStr, PHPArray, PHPObject } from '../values.js';
import { toDbl, toInt, toStr } from '../convert.js';
import { rt } from '../runtime/state.js';
import { throwError } from '../runtime/errors.js';
import { callNative } from '../runtime/functions.js';
import { callValue } from '../runtime/callables.js';
import { def, I } from './core.js';

// filter_var (common subset)
def('filter_var', (value, filter = 516, options = 0) => {
  const f = I(filter);
  let flags = 0, opts = null, def_ = undefined;
  if (options instanceof PHPArray) { flags = toInt(options.get('flags') || 0); opts = options.get('options') || null; if (opts instanceof PHPArray && opts.has('default')) def_ = opts.get('default'); }
  else flags = toInt(options);
  const nullOnFail = (flags & 134217728) !== 0;
  const fail = () => (def_ !== undefined ? def_ : nullOnFail ? null : false);
  const s = typeof value === 'string' ? value.trim() : toStr(value);
  switch (f) {
    case 257: {
      let n = null;
      if (/^[+-]?(0|[1-9]\d*)$/.test(s)) n = numericStr(s);
      else if ((flags & 2) && /^0x[0-9a-f]+$/i.test(s)) n = parseInt(s, 16);
      else if ((flags & 1) && /^0[0-7]+$/.test(s)) n = parseInt(s, 8);
      if (n === null || n instanceof Flt) return fail();
      if (opts instanceof PHPArray) { if (opts.has('min_range') && n < toInt(opts.get('min_range'))) return fail(); if (opts.has('max_range') && n > toInt(opts.get('max_range'))) return fail(); }
      return n;
    }
    case 258: { const l = s.toLowerCase(); if (['1', 'true', 'on', 'yes'].includes(l)) return true; if (['0', 'false', 'off', 'no', ''].includes(l)) return value === false || l !== '' || !nullOnFail ? false : null; return nullOnFail ? null : false; }
    case 259: { let t = s; if (flags & 8192) t = t.replace(/,/g, ''); const n = numericStr(t); return n === null ? fail() : mkf(toDbl(n)); }
    case 274: return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(s) ? s : fail();
    case 273: return /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+[^\s]*$/i.test(s) || /^(mailto|news|file):[^\s]+$/i.test(s) ? s : fail();
    case 275: {
      const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);
      const v6 = !v4 && /^[0-9a-f:]+$/i.test(s) && s.includes(':') && (s.match(/::/g) || []).length <= 1;
      if ((flags & 1048576) && !(flags & 2097152)) return v4 ? s : fail();
      if ((flags & 2097152) && !(flags & 1048576)) return v6 ? s : fail();
      return v4 || v6 ? s : fail();
    }
    case 272: { const re = opts instanceof PHPArray ? opts.get('regexp') : null; if (!re) throwError('ValueError', "filter_var(): \"regexp\" option missing"); return callNative(rt.fns.get('preg_match'), [re, s]) ? s : fail(); }
    case 277: return /^[a-z0-9.-]+$/i.test(s) ? s : fail();
    case 519: return toStr(value).replace(/[^0-9+-]/g, '');
    case 520: return toStr(value).replace((flags & 4096) ? /[^0-9+\-.eE]/g : /[^0-9+-]/g, '');
    case 515: case 522: return callNative(rt.fns.get('htmlspecialchars'), [toStr(value), 3]);
    case 517: return toStr(value).replace(/[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~@[\]-]/g, '');
    case 518: return toStr(value).replace(/[^A-Za-z0-9$\-_.+!*'(),{}|\\^~[\]`<>#%";/?:@&=]/g, '');
    case 523: return callNative(rt.fns.get('addslashes'), [toStr(value)]);
    case 513: return toStr(value).replace(/<[^>]*>?/g, '').replace(/["']/g, (c) => (c === '"' ? '&#34;' : '&#39;'));
    case 1024: return opts ? callValue(opts, [value]) : fail();
    default: return value instanceof PHPArray || value instanceof PHPObject ? fail() : toStr(value);
  }
});
def('filter_has_var', () => false);
def('filter_input', () => null);
def('filter_list', () => PHPArray.from(['int', 'boolean', 'float', 'validate_regexp', 'validate_url', 'validate_email', 'validate_ip', 'string', 'unsafe_raw', 'email', 'url', 'number_int', 'number_float', 'callback']));
def('setlocale', (category, ...locales) => 'C');
def('localeconv', () => PHPArray.fromPairs([['decimal_point', '.'], ['thousands_sep', ''], ['int_curr_symbol', ''], ['currency_symbol', ''], ['mon_decimal_point', ''], ['mon_thousands_sep', ''], ['positive_sign', ''], ['negative_sign', '']]));
