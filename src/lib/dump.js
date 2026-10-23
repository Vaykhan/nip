// var_dump, print_r, var_export, debug_zval_refcount.

import { FatalSig, Flt, fmtRepr, fmtReprZ, PHPArray, PHPObject, PHPResource, Ref } from '../values.js';
import { toBool, toStr } from '../convert.js';
import { rt } from '../runtime/state.js';
import { warn } from '../runtime/errors.js';
import { callFunction, typeStr } from '../runtime/functions.js';
import { displayName, nipProps, objectProps } from '../runtime/classes.js';
import { containsRefSlot, refHolderCounts } from '../runtime/gc.js';
import { def, deref } from './core.js';

function varDump(v, ind, seen, rc) {
  let amp = '';
  if (v instanceof Ref) { if (rc && (rc.get(v) || 0) > 1) amp = '&'; v = v.v; }
  if (amp) return varDump0(v, ind, seen, rc).replace(/^(\s*)/, '$1&');
  return varDump0(v, ind, seen, rc);
}
function varDump0(v, ind, seen, rc) {
  const pad = ' '.repeat(ind);
  if (v === null || v === undefined) return pad + 'NULL\n';
  switch (typeof v) {
    case 'boolean': return pad + `bool(${v})\n`;
    case 'number': case 'bigint': return pad + `int(${v})\n`;
    case 'string': return pad + `string(${v.length}) "${v}"\n`;
  }
  if (v instanceof Flt) return pad + `float(${fmtRepr(v.v)})\n`;
  if (v instanceof PHPArray) {
    if (seen.has(v)) return pad + '*RECURSION*\n';
    seen.add(v);
    let s = pad + `array(${v.size}) {\n`;
    for (const [k, x] of v.rawEntries()) s += pad + `  [${typeof k === 'string' ? '"' + k + '"' : k}]=>\n` + varDump(x, ind + 2, seen, rc);
    seen.delete(v);
    return s + pad + '}\n';
  }
  if (v instanceof PHPObject) {
    if (v.cls.isEnum) return pad + `enum(${v.cls.name}::${v.props.get('name')})\n`;
    if (seen.has(v)) return pad + '*RECURSION*\n';
    seen.add(v);
    const entries = debugProps(v);
    let s = pad + `object(${v.cls.anon ? displayName(v.cls) : v.cls.name})#${v.id} (${entries.length}) {\n`;
    for (const [label, x, uninit] of entries) {
      s += pad + `  [${label}]=>\n`;
      s += uninit ? pad + `  uninitialized(${uninit})\n` : varDump(x, ind + 2, seen, rc);
    }
    seen.delete(v);
    return s + pad + '}\n';
  }
  if (v instanceof PHPResource) return pad + `resource(${v.id}) of type (${v.closed ? 'Unknown' : v.type})\n`;
  return pad + 'NULL\n';
}
// [label, value, uninitializedType] for var_dump
function debugInfo(o) {
  const m = o.cls.methods.get('__debuginfo');
  if (!m) return null;
  const r = callFunction(m.fn, [], o, m.cls, o.cls, null);
  if (r === null) return new PHPArray();
  if (!(r instanceof PHPArray)) throw new FatalSig('__debuginfo() must return an array');
  return r;
}
function debugProps(o) {
  if (o.cls.nativeDebug) return o.cls.nativeDebug(o).map(([k, v]) => [typeof k === 'string' ? `"${k}"` : String(k), v]);
  const di = debugInfo(o);
  if (di) return di.rawEntries().map(([k, v]) => [typeof k === 'string' ? propLabel(o, k, true) : String(k), v]);
  const np = nipProps(o);
  if (np) return np.rawEntries().map(([k, v]) => [typeof k === 'string' ? `"${k}"` : String(k), v]);
  const out = [];
  const seenKeys = new Set();
  for (const [key, info] of o.cls.slots) {
    if (!o.props.has(key) && info.type && !info.internal) { out.push([propLabel(o, key, true), null, typeStr(info.type, info.cls)]); seenKeys.add(key); }
  }
  const res = [];
  for (const [k, s] of objectProps(o)) res.push([propLabel(o, k, true), s]);
  // order: declared slots first in declaration order, uninitialized shown in place
  if (out.length) {
    const ordered = [];
    for (const [key] of o.cls.slots) {
      if (o.props.has(key)) ordered.push([propLabel(o, key, true), o.props.get(key)]);
      else if (seenKeys.has(key)) ordered.push(out.find((x) => x[0] === propLabel(o, key, true)));
    }
    for (const [k, s] of o.props) if (!o.cls.slots.has(k)) ordered.push([propLabel(o, k, true), s]);
    return ordered;
  }
  return res;
}
function propLabel(o, key, dump) {
  if (key.charCodeAt(0) === 0) {
    const p = key.indexOf('\0', 1);
    const owner = key.slice(1, p), name = key.slice(p + 1);
    if (owner === '*') return dump ? `"${name}":protected` : `${name}:protected`;
    return dump ? `"${name}":"${owner}":private` : `${name}:${owner}:private`;
  }
  const info = o.cls.props.get(key);
  if (info && info.vis === 'protected') return dump ? `"${key}":protected` : `${key}:protected`;
  return dump ? `"${key}"` : key;
}

function printR(v, ind, seen) {
  if (v instanceof Ref) v = v.v;
  if (v instanceof PHPArray || (v instanceof PHPObject && !v.cls.isEnumX)) {
    const isArr = v instanceof PHPArray;
    if (seen.has(v)) return isArr ? 'Array\n *RECURSION*' : `${v.cls.name} Object\n *RECURSION*`;
    seen.add(v);
    const pad = ' '.repeat(ind);
    let s;
    let entries;
    if (isArr) { s = 'Array\n'; entries = v.entries().map(([k, x]) => [String(k), x]); }
    else {
      s = v.cls.isEnum ? `${v.cls.name} Enum${v.cls.enumBacked ? ':' + v.cls.enumBacked : ''}\n` : `${v.cls.anon ? displayName(v.cls) : v.cls.name} Object\n`;
      const di = v.cls.nativeDebug ? null : debugInfo(v);
      if (v.cls.nativeDebug) entries = v.cls.nativeDebug(v).map(([k, x]) => [String(k), x]);
      else if (di) entries = di.entries().map(([k, x]) => [typeof k === 'string' ? propLabel(v, k, false) : String(k), x]);
      else { const np = nipProps(v); entries = np ? np.entries().map(([k, x]) => [String(k), x]) : objectProps(v).map(([k, x]) => [propLabel(v, k, false), deref(x)]); }
    }
    s += pad + '(\n';
    for (const [k, x] of entries) s += pad + `    [${k}] => ` + printR(x, ind + 8, seen) + '\n';
    s += pad + ')\n';
    seen.delete(v);
    return s;
  }
  return toStr(v);
}

function exportStr(s) {
  let out = "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (s.includes('\0')) out = out.split('\0').join('\' . "\\0" . \'');
  return out;
}
function varExport(v, ind, seen) {
  if (v instanceof Ref) v = v.v;
  const pad = ' '.repeat(ind);
  if (v === null || v === undefined) return 'NULL';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number': case 'bigint': return String(v);
    case 'string': return exportStr(v);
  }
  if (v instanceof Flt) return fmtReprZ(v.v);
  if (v instanceof PHPArray) {
    if (seen.has(v)) { warn('var_export does not handle circular references'); return 'NULL'; }
    seen.add(v);
    let s = 'array (\n';
    for (const [k, x] of v.entries()) {
      s += pad + '  ' + (typeof k === 'string' ? exportStr(k) : k) + ' => ';
      if ((x instanceof PHPArray) || (x instanceof PHPObject && !x.cls.isEnum)) s += '\n' + pad + '  ' + varExport(x, ind + 2, seen);
      else s += varExport(x, ind + 2, seen);
      s += ',\n';
    }
    seen.delete(v);
    return s + pad + ')';
  }
  if (v instanceof PHPObject) {
    if (v.cls.isEnum) return '\\' + v.cls.name + '::' + v.props.get('name');
    if (seen.has(v)) { warn('var_export does not handle circular references'); return 'NULL'; }
    seen.add(v);
    const isStd = v.cls.lname === 'stdclass';
    let s = isStd ? '(object) array(\n' : '\\' + v.cls.name + '::__set_state(array(\n';
    const np = nipProps(v);
    for (const [k, x0] of np ? np.entries().map(([k, x]) => [String(k), x]) : objectProps(v)) {
      const x = deref(x0);
      const name = k.charCodeAt(0) === 0 ? k.slice(k.indexOf('\0', 1) + 1) : k;
      s += pad + '   ' + exportStr(name) + ' => ';
      if ((x instanceof PHPArray) || (x instanceof PHPObject && !x.cls.isEnum)) s += '\n' + pad + '  ' + varExport(x, ind + 2, seen);
      else s += varExport(x, ind + 2, seen);
      s += ',\n';
    }
    seen.delete(v);
    return s + pad + (isStd ? ')' : '))');
  }
  return 'NULL';
}

def('var_dump', (...vals) => {
  for (const v of vals) {
    const rc = containsRefSlot(v, new Set()) ? refHolderCounts([v]) : null;
    rt.echo(varDump(v, 0, new Set(), rc));
  }
}, { min: 1 });
def('print_r', (value, _return = false) => { const s = printR(value, 0, new Set()); if (toBool(_return)) return s; rt.echo(s); return true; });
def('var_export', (value, _return = false) => { const s = varExport(value, 0, new Set()); if (toBool(_return)) return s; rt.echo(s); return null; });
def('debug_zval_refcount', () => 1);
