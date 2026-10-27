// The PHP version NIP emulates: -d nip.php_version=8.3 (the default), 8.4 or 8.5. Newer
// syntax is rejected and newer functions and classes don't exist under an older version.

import { rt } from './state.js';

export const VERSIONS = { '8.3': [8, 3, 6], '8.4': [8, 4, 14], '8.5': [8, 5, 0] };
export const DEFAULT_VERSION = '8.3';
// functions and classes added after 8.3 (lowercase name -> version id)
const SINCE_FNS = new Map(), SINCE_CLASSES = new Map();
export function since(id, kind, ...names) {
  const m = kind === 'class' ? SINCE_CLASSES : SINCE_FNS;
  for (const n of names) m.set(n.toLowerCase(), id);
}
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
  for (const [n, id] of SINCE_FNS) if (id > rt.phpVersion) rt.fns.delete(n);
  for (const [n, id] of SINCE_CLASSES) if (id > rt.phpVersion) rt.classes.delete(n);
}
