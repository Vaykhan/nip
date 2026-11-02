// The PHP version NIP emulates: -d nip.php_version=8.3 (the default), 8.4 or 8.5. Newer
// syntax is rejected and newer functions and classes don't exist under an older version.

import { rt } from './state.js';

export const VERSIONS = { '8.3': [8, 3, 6], '8.4': [8, 4, 14], '8.5': [8, 5, 0] };
export const DEFAULT_VERSION = '8.3';
// functions and classes added after 8.3 (lowercase name -> version id)
const SINCE_FNS = new Map(), SINCE_CLASSES = new Map();
// methods and class constants of older classes ('Class::name' -> version id)
const SINCE_MEMBERS = { method: new Map(), const: new Map() };
export function since(id, kind, ...names) {
  if (kind === 'method' || kind === 'const') { for (const n of names) SINCE_MEMBERS[kind].set(n, id); return; }
  const m = kind === 'class' ? SINCE_CLASSES : SINCE_FNS;
  for (const n of names) m.set(n.toLowerCase(), id);
}
// the members hideNewer() took out of (shared) class objects, to put back for a newer version
const hiddenMembers = new Map();
export const versionId = ([a, b, c]) => a * 10000 + b * 100 + c;
// version id that compares as "at least 8.N" (80400 for 8.4)
export const atLeast = (minor) => rt.phpVersion >= 80000 + minor * 100;

// called at the start of each run, after the INI settings are applied
export function applyVersion() {
  const want = String(rt.ini.get('nip.php_version') ?? DEFAULT_VERSION).trim();
  const v = VERSIONS[want] || VERSIONS[want.split('.').slice(0, 2).join('.')] || VERSIONS[DEFAULT_VERSION];
  rt.phpVersion = versionId(v);
  rt.phpVersionStr = v.join('.');
  const c = (k, x) => rt.consts.set(k, x);
  c('PHP_VERSION', rt.phpVersionStr); c('PHP_MAJOR_VERSION', v[0]); c('PHP_MINOR_VERSION', v[1]); c('PHP_RELEASE_VERSION', v[2]); c('PHP_VERSION_ID', rt.phpVersion);
  if (rt.phpVersion >= 80400) { // (E_STRICT is gone)
    c('E_ALL', 30719);
    rt.deprecatedConsts.set('E_STRICT', { msg: 'Constant E_STRICT is deprecated since 8.4, the error level was removed' });
  }
  hideNewer();
}
// removes what the emulated version doesn't have (again after a prelude file is loaded lazily)
export function hideNewer() {
  patchConsts();
  for (const [n, id] of SINCE_FNS) if (id > rt.phpVersion) rt.fns.delete(n);
  for (const [n, id] of SINCE_CLASSES) if (id > rt.phpVersion) rt.classes.delete(n);
  for (const kind of ['method', 'const']) {
    for (const [n, id] of SINCE_MEMBERS[kind]) {
      const [cn, mn] = n.split('::');
      const lcn = cn.toLowerCase(), key = kind === 'method' ? mn.toLowerCase() : mn;
      // (the class and its subclasses, which have their own copies of the member maps)
      for (const c of rt.classes.values()) {
        if (!c.ancestors || !c.ancestors.has(lcn)) continue;
        const map = kind === 'method' ? c.methods : c.consts, hk = kind + ' ' + c.lname + '::' + key;
        if (id > rt.phpVersion) { const e = map.get(key); if (e !== undefined && (kind === 'const' || e.cls.lname === lcn)) { hiddenMembers.set(hk, e); map.delete(key); } }
        else if (hiddenMembers.has(hk)) { map.set(key, hiddenMembers.get(hk)); hiddenMembers.delete(hk); }
      }
    }
  }
}
// class constants whose values changed (Attribute::TARGET_ALL and IS_REPEATABLE: PHP 8.5 added
// TARGET_CONSTANT)
function patchConsts() {
  const a = rt.classes.get('attribute');
  if (!a) return;
  const v85 = rt.phpVersion >= 80500;
  for (const [n, v] of [['TARGET_ALL', v85 ? 127 : 63], ['IS_REPEATABLE', v85 ? 128 : 64]]) { const c = a.consts.get(n); if (c) { c.val = v; c.done = true; } }
}
export const hiddenClass = (ln) => (SINCE_CLASSES.get(ln) ?? 0) > rt.phpVersion;

// engine attributes of later versions (src/prelude)
since(80400, 'class', 'Deprecated');
since(80500, 'class', 'NoDiscard');
// lazy objects
since(80400, 'method', 'ReflectionClass::newLazyGhost', 'ReflectionClass::newLazyProxy', 'ReflectionClass::resetAsLazyGhost', 'ReflectionClass::resetAsLazyProxy',
  'ReflectionClass::initializeLazyObject', 'ReflectionClass::isUninitializedLazyObject', 'ReflectionClass::markLazyObjectAsInitialized', 'ReflectionClass::getLazyInitializer',
  'ReflectionProperty::setRawValueWithoutLazyInitialization', 'ReflectionProperty::skipLazyInitialization', 'ReflectionProperty::isLazy');
since(80400, 'const', 'ReflectionClass::SKIP_INITIALIZATION_ON_SERIALIZE', 'ReflectionClass::SKIP_DESTRUCTOR');
// property hooks and asymmetric visibility
since(80400, 'class', 'PropertyHookType', 'ReflectionConstant');
since(80500, 'method', 'ReflectionConstant::getFileName', 'ReflectionConstant::getExtension', 'ReflectionConstant::getExtensionName', 'ReflectionConstant::getAttributes');
since(80400, 'method', 'ReflectionProperty::getRawValue', 'ReflectionProperty::setRawValue', 'ReflectionProperty::isPrivateSet', 'ReflectionProperty::isProtectedSet',
  'ReflectionProperty::isDynamic', 'ReflectionProperty::isAbstract', 'ReflectionProperty::isVirtual', 'ReflectionProperty::getSettableType', 'ReflectionProperty::hasHooks',
  'ReflectionProperty::getHooks', 'ReflectionProperty::hasHook', 'ReflectionProperty::getHook', 'ReflectionProperty::isFinal');
since(80400, 'const', 'ReflectionProperty::IS_ABSTRACT', 'ReflectionProperty::IS_PROTECTED_SET', 'ReflectionProperty::IS_PRIVATE_SET', 'ReflectionProperty::IS_VIRTUAL', 'ReflectionProperty::IS_FINAL');
since(80500, 'method', 'ReflectionProperty::getMangledName');
since(80500, 'const', 'Attribute::TARGET_CONSTANT');
