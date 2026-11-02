// json_encode / json_decode.

import {
  Flt, fmtRepr, fmtReprZ, I64MAX, I64MIN, mkf, normBig, normKey, numericStr, PHPArray, PHPObject, Ref,
  ThrowSig
} from '../values.js';
import { toBool } from '../convert.js';
import { isValidUtf8, utf8Decode, utf8Encode } from '../utf8.js';
import { rt } from '../runtime/state.js';
import { makeException } from '../runtime/errors.js';
import { callMethodName, nipProps, objVisibleProps } from '../runtime/classes.js';
import { def, I, S } from './core.js';

const JSON_ERR_MSG = { 0: 'No error', 1: 'Maximum stack depth exceeded', 2: 'State mismatch (invalid or malformed JSON)', 3: 'Control character error, possibly incorrectly encoded', 4: 'Syntax error', 5: 'Malformed UTF-8 characters, possibly incorrectly encoded', 6: 'Recursion detected', 7: 'Inf and NaN cannot be JSON encoded', 8: 'Type is not supported', 9: 'The decoded property name is invalid', 10: 'Single unpaired UTF-16 surrogate in unicode escape' };
let jsonLastError = 0;
export function resetJsonState() { jsonLastError = 0; }
export class JsonErr { constructor(code) { this.code = code; } }
let jsonPartialErr = 0;
function jsonFail(flags, code, repl) { if (flags & 512) { jsonPartialErr = code; return repl; } throw new JsonErr(code); }
function jsonStr(s, flags, isKey) {
  let u;
  if (isValidUtf8(s)) u = utf8Decode(s);
  else if (flags & 1048576) u = Buffer.from(s, 'latin1').toString('utf8').replace(/\uFFFD/g, '');
  else if (flags & 2097152) u = Buffer.from(s, 'latin1').toString('utf8');
  else return jsonFail(flags, 5, isKey ? '""' : 'null');
  let out = '"';
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i), ch = u[i];
    switch (ch) {
      case '"': out += (flags & 8) ? '\\u0022' : '\\"'; continue;
      case '\\': out += '\\\\'; continue;
      case '/': out += (flags & 64) ? '/' : '\\/'; continue;
      case '\b': out += '\\b'; continue;
      case '\f': out += '\\f'; continue;
      case '\n': out += '\\n'; continue;
      case '\r': out += '\\r'; continue;
      case '\t': out += '\\t'; continue;
      case '<': if (flags & 1) { out += '\\u003C'; continue; } break;
      case '>': if (flags & 1) { out += '\\u003E'; continue; } break;
      case '&': if (flags & 2) { out += '\\u0026'; continue; } break;
      case "'": if (flags & 4) { out += '\\u0027'; continue; } break;
    }
    if (c < 0x20) { out += '\\u' + c.toString(16).padStart(4, '0'); continue; }
    if (c > 127) {
      if ((flags & 256) && !((c === 0x2028 || c === 0x2029) && !(flags & 2048))) { out += ch; continue; }
      out += '\\u' + c.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  out += '"';
  return (flags & 256) ? utf8Encode(out) : out;
}
function jsonEncode(v, flags, depth, ind, seen) {
  if (depth < 0) throw new JsonErr(1);
  if (v instanceof Ref) v = v.v;
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number': case 'bigint': return String(v);
    case 'string': {
      if (flags & 32) { const n = numericStr(v); if (n !== null && !(n instanceof Flt && !isFinite(n.v))) return jsonEncode(n, flags, depth, ind, seen); }
      return jsonStr(v, flags);
    }
  }
  if (v instanceof Flt) {
    if (!isFinite(v.v)) return jsonFail(flags, 7, '0');
    const s = (flags & 1024) ? fmtReprZ(v.v) : fmtRepr(v.v);
    return s.replace('E', 'e');
  }
  const pretty = (flags & 128) !== 0;
  const nl = pretty ? '\n' : '', pad = pretty ? '    '.repeat(ind + 1) : '', endPad = pretty ? '    '.repeat(ind) : '';
  if (v instanceof PHPArray) {
    if (seen.has(v)) return jsonFail(flags, 6, 'null');
    if (v.size === 0) return (flags & 16) ? '{}' : '[]';
    seen.add(v);
    try {
      if (v.isList() && !(flags & 16)) {
        const parts = v.values().map((x) => pad + jsonEncode(x, flags, depth - 1, ind + 1, seen));
        return '[' + nl + parts.join(',' + nl) + nl + endPad + ']';
      }
      const parts = v.entries().map(([k, x]) => pad + jsonStr(String(k), flags, true) + (pretty ? ': ' : ':') + jsonEncode(x, flags, depth - 1, ind + 1, seen));
      return '{' + nl + parts.join(',' + nl) + nl + endPad + '}';
    } finally { seen.delete(v); }
  }
  if (v instanceof PHPObject) {
    if (v.cls.ancestors.has('jsonserializable')) {
      if (seen.has(v)) return jsonFail(flags, 6, 'null');
      seen.add(v);
      let r;
      try { r = callMethodName(v, 'jsonSerialize', []); } finally { seen.delete(v); }
      if (r !== v) { seen.add(v); try { return jsonEncode(r, flags, depth, ind, seen); } finally { seen.delete(v); } }
    }
    if (v.cls.isEnum) { if (!v.cls.enumBacked) return jsonFail(flags, 8, '0'); return jsonEncode(v.props.get('value'), flags, depth, ind, seen); }
    if (seen.has(v)) return jsonFail(flags, 6, 'null');
    const np = v.cls.nativeToArray ? null : nipProps(v);
    const props = v.cls.nativeToArray ? v.cls.nativeToArray(v).entries() : np ? np.entries() : objVisibleProps(v, null);
    if (!props.length) return '{}';
    seen.add(v);
    try {
      const parts = props.map(([k, x]) => pad + jsonStr(String(k), flags, true) + (pretty ? ': ' : ':') + jsonEncode(x, flags, depth - 1, ind + 1, seen));
      return '{' + nl + parts.join(',' + nl) + nl + endPad + '}';
    } finally { seen.delete(v); }
  }
  return jsonFail(flags, 8, 'null');
}
def('json_encode', (value, flags = 0, depth = 512) => {
  const fl = I(flags);
  try {
    jsonPartialErr = 0;
    const r = jsonEncode(value, fl, I(depth), 0, new Set());
    jsonLastError = jsonPartialErr;
    return r;
  } catch (e) {
    if (!(e instanceof JsonErr)) throw e;
    if (fl & 4194304) { const ex = makeException('JsonException', JSON_ERR_MSG[e.code]); ex.props.set('code', e.code); throw new ThrowSig(ex); }
    jsonLastError = e.code;
    if (fl & 512) return 'null';
    return false;
  }
});
function jsonDecode(text, assoc, maxDepth, flags) {
  const s = text;
  let i = 0;
  const err = (c) => { throw new JsonErr(c || 4); };
  const ws = () => { while (i < s.length) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } };
  const val = (depth) => {
    if (depth > maxDepth) err(1);
    ws();
    const c = s[i];
    if (c === '{') {
      i++; ws();
      const obj = assoc ? new PHPArray() : new PHPObject(rt.classes.get('stdclass'));
      if (s[i] === '}') { i++; return obj; }
      for (;;) {
        ws(); if (s[i] !== '"') err();
        const k = str();
        ws(); if (s[i] !== ':') err(); i++;
        const v = val(depth + 1);
        if (assoc) obj.set(normKey(k), v); else { if (k.startsWith('\0') && k.length) err(9); obj.props.set(k, v); }
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return obj; }
        err();
      }
    }
    if (c === '[') {
      i++; ws();
      const arr = new PHPArray();
      if (s[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(val(depth + 1));
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        err();
      }
    }
    if (c === '"') return str();
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 400));
    if (!m) err();
    i += m[0].length;
    if (m[1] === undefined && m[2] === undefined) {
      const b = BigInt(m[0]);
      if (b > I64MAX || b < I64MIN) return (flags & 2) ? m[0] : mkf(Number(m[0]));
      return normBig(b);
    }
    return mkf(Number(m[0]));
  };
  const str = () => {
    i++;
    let out = '';
    for (;;) {
      if (i >= s.length) err();
      const c = s[i];
      if (c === '"') { i++; break; }
      if (c === '\\') {
        const e = s[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (map[e] !== undefined) { out += map[e]; i += 2; continue; }
        if (e === 'u') {
          const h = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) err();
          let cp = parseInt(h, 16); i += 6;
          if (cp >= 0xd800 && cp <= 0xdbff) {
            if (s[i] === '\\' && s[i + 1] === 'u') { const lo = parseInt(s.slice(i + 2, i + 6), 16); if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i += 6; } else err(10); }
            else err(10);
          } else if (cp >= 0xdc00 && cp <= 0xdfff) err(10);
          out += String.fromCodePoint(cp); continue;
        }
        err();
      }
      if (c.charCodeAt(0) < 0x20) err(3);
      out += c; i++;
    }
    return utf8Encode(out);
  };
  const r = val(1);
  ws();
  if (i < s.length) err();
  return r;
}
def('json_decode', (json, associative = null, depth = 512, flags = 0) => {
  const fl = I(flags);
  const assoc = associative === null ? (fl & 1) !== 0 : toBool(associative);
  const j = S(json);
  try {
    if (j === '') throw new JsonErr(4);
    if (!isValidUtf8(j)) throw new JsonErr(5);
    const r = jsonDecode(utf8Decode(j), assoc, I(depth), fl);
    jsonLastError = 0;
    return r;
  } catch (e) {
    if (!(e instanceof JsonErr)) throw e;
    if (fl & 4194304) { const ex = makeException('JsonException', JSON_ERR_MSG[e.code]); ex.props.set('code', e.code); throw new ThrowSig(ex); }
    jsonLastError = e.code;
    return null;
  }
});
def('json_last_error', () => jsonLastError);
def('json_last_error_msg', () => JSON_ERR_MSG[jsonLastError] || 'Unknown error');
def('json_validate', (json, depth = 512, flags = 0) => { try { jsonDecode(utf8Decode(S(json)), true, I(depth), 0); jsonLastError = 0; return true; } catch (e) { if (e instanceof JsonErr) { jsonLastError = e.code; return false; } throw e; } });
