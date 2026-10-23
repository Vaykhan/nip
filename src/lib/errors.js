// Error handling and runtime configuration: error_reporting, set_error_handler, ini_*, ...

import fs from 'node:fs';
import osMod from 'node:os';
import { FatalSig, mkf, PHPArray, PHPObject, ThrowSig } from '../values.js';
import { toBool, toInt, toStr } from '../convert.js';
import { bytes, utf8Encode } from '../utf8.js';
import {
  E_ALL, E_USER_DEPRECATED, E_USER_ERROR, E_USER_NOTICE, E_USER_WARNING, rt, writeFd
} from '../runtime/state.js';
import { captureTrace, raise, setTimeLimit, throwError, traceAsString } from '../runtime/errors.js';
import { boundCallback, callableFn, callValue } from '../runtime/callables.js';
import { looseEq } from '../compare.js';
import { alias, def, I, S } from './core.js';
import { sgn } from './string.js';
import { PHP_VERSION } from '../runtime/native-classes.js';

def('error_reporting', (error_level = null) => { const old = rt.silence ? rt.errorReporting & 4437 : rt.errorReporting; if (error_level !== null) rt.errorReporting = I(error_level); return old; });
export const INI_DEFAULTS = {
  'arg_separator.output': '&', 'arg_separator.input': '&', 'assert.active': '1', 'assert.exception': '1', 'assert.warning': '1', 'assert.bail': '0', 'assert.callback': '',
  'auto_detect_line_endings': '0', 'default_charset': 'UTF-8', 'default_socket_timeout': '60', 'display_startup_errors': '1', 'docref_root': '', 'docref_ext': '',
  'error_log': '', 'error_prepend_string': '', 'error_append_string': '', 'html_errors': '0', 'ignore_repeated_errors': '0', 'ignore_user_abort': '0', 'implicit_flush': '1',
  'include_path': '.:/usr/share/php', 'log_errors': '0', 'max_execution_time': '0', 'max_input_time': '-1', 'memory_limit': '128M', 'output_buffering': '0', 'output_handler': '',
  'register_argc_argv': '1', 'report_memleaks': '1', 'short_open_tag': '0', 'user_agent': '', 'variables_order': 'EGPCS', 'zend.assertions': '-1', 'zend.enable_gc': '1',
  'zend.exception_ignore_args': '1', 'zend.exception_string_param_max_len': '0', 'date.timezone': 'UTC', 'mbstring.language': 'neutral', 'mbstring.internal_encoding': '',
  'pcre.backtrack_limit': '1000000', 'pcre.recursion_limit': '100000', 'pcre.jit': '1', 'session.save_path': '', 'session.name': 'PHPSESSID', 'session.use_cookies': '1',
  'serialize_precision': '-1', 'precision': '14', 'display_errors': '0', 'error_reporting': '', 'open_basedir': '', 'file_uploads': '1', 'upload_max_filesize': '2M',
  'post_max_size': '8M', 'allow_url_fopen': '1', 'allow_url_include': '0', 'auto_prepend_file': '', 'auto_append_file': '', 'sys_temp_dir': '', 'xmlrpc_errors': '0',
  'highlight.comment': '#FF8000', 'highlight.default': '#0000BB', 'highlight.html': '#000000', 'highlight.keyword': '#007700', 'highlight.string': '#DD0000',
  'unserialize_callback_func': '', 'unserialize_max_depth': '4096', 'zend.multibyte': '0', 'zend.detect_unicode': '1', 'expose_php': '1', 'enable_dl': '1',
  'max_input_nesting_level': '64', 'max_input_vars': '1000', 'realpath_cache_size': '4096K', 'realpath_cache_ttl': '120', 'opcache.enable': '0', 'opcache.enable_cli': '0',
};
def('ini_set', (option, value) => {
  const k = S(option); const v = value === null ? '' : toStr(value);
  if (!(k in INI_DEFAULTS) && !rt.ini.has(k)) return false;
  const old = ini_get(k);
  if (k === 'display_errors') rt.displayErrors = (v === '1' || v.toLowerCase() === 'on' || v.toLowerCase() === 'true' || v.toLowerCase() === 'stdout') ? 'stdout' : (v.toLowerCase() === 'stderr' ? 'stderr' : '0');
  else if (k === 'error_reporting') rt.errorReporting = toInt(v);
  else if (k === 'precision') rt.precision = toInt(v);
  else if (k === 'max_execution_time') setTimeLimit(toInt(v));
  else if (k === 'serialize_precision') rt.serializePrecision = toInt(v);
  else if (k === 'date.timezone') rt.tz = v;
  rt.ini.set(k, v);
  return old;
});
alias('ini_alter', 'ini_set');
function ini_get(k) {
  if (rt.ini.has(k)) return rt.ini.get(k);
  switch (k) {
    case 'display_errors': return rt.displayErrors === 'stdout' ? '1' : rt.displayErrors === 'stderr' ? 'stderr' : '0';
    case 'error_reporting': return String(rt.errorReporting);
    case 'precision': return String(rt.precision);
    case 'serialize_precision': return String(rt.serializePrecision);
    case 'memory_limit': return '128M';
    case 'max_execution_time': return String(rt.timeLimit);
    case 'date.timezone': return rt.tz;
    case 'default_charset': return 'UTF-8';
    case 'include_path': return '.:/usr/share/php';
  }
  if (k in INI_DEFAULTS) return INI_DEFAULTS[k];
  return false;
}
def('ini_get', (option) => ini_get(S(option)));
def('ini_get_all', () => new PHPArray());
def('ini_restore', (option) => { rt.ini.delete(S(option)); });
def('set_include_path', (include_path) => { const old = ini_get('include_path'); rt.ini.set('include_path', S(include_path)); return old; });
def('get_include_path', () => ini_get('include_path'));
def('set_error_handler', (callback, error_levels = E_ALL) => {
  const prev = rt.errorHandlers.length ? rt.errorHandlers[rt.errorHandlers.length - 1].handler : null;
  rt.errorHandlers.push({ handler: callback, mask: I(error_levels) });
  return prev;
});
def('restore_error_handler', () => { rt.errorHandlers.pop(); return true; });
def('set_exception_handler', (callback) => { const prev = rt.exceptionHandlers.length ? rt.exceptionHandlers[rt.exceptionHandlers.length - 1] : null; rt.exceptionHandlers.push(callback); return prev; });
def('restore_exception_handler', () => { rt.exceptionHandlers.pop(); return true; });
def('trigger_error', (message, error_level = E_USER_NOTICE) => {
  const lvl = I(error_level);
  if (![E_USER_ERROR, E_USER_WARNING, E_USER_NOTICE, E_USER_DEPRECATED].includes(lvl)) throwError('ValueError', 'trigger_error(): Argument #2 ($error_level) must be one of E_USER_ERROR, E_USER_WARNING, E_USER_NOTICE, or E_USER_DEPRECATED');
  if (lvl === E_USER_ERROR) {
    if (rt.errorHandlers.length) { const h = rt.errorHandlers[rt.errorHandlers.length - 1]; if (h.handler !== null && (h.mask & lvl)) { const r = callValue(h.handler, [lvl, S(message), rt.file, rt.line]); if (r !== false) return true; } }
    throw new FatalSig(S(message), rt.line, rt.file);
  }
  raise(lvl, S(message));
  return true;
});
alias('user_error', 'trigger_error');
def('error_log', (message, message_type = 0, destination = null) => {
  const t = I(message_type);
  if (t === 3 && destination !== null) { fs.appendFileSync(S(destination), bytes(S(message))); return true; }
  rt.flush(); writeFd(2, bytes(S(message) + '\n')); return true;
});
def('error_get_last', () => {
  if (!rt.lastError) return null;
  return PHPArray.fromPairs([['type', rt.lastError.type], ['message', rt.lastError.message], ['file', rt.lastError.file], ['line', rt.lastError.line]]);
});
def('error_clear_last', () => { rt.lastError = null; });
def('register_shutdown_function', (callback, ...args) => { rt.shutdownFns.push([boundCallback(callback), args]); });
def('register_tick_function', (callback, ...args) => {
  callableFn(callback); // validates, with PHP's message
  rt.tickFns.push({ cb: callback, args, calling: false });
  return true;
});
def('unregister_tick_function', (callback) => {
  callableFn(callback);
  rt.tickFns = rt.tickFns.filter((t) => !looseEq(t.cb, callback));
  return null;
});
def('assert', (assertion, description = null) => {
  if (!/^(1|on|true|yes)$/i.test(String(rt.ini.get('assert.active') ?? '1'))) return true;
  if (toBool(assertion)) return true;
  if (description instanceof PHPObject) throw new ThrowSig(description);
  throwError('AssertionError', description === null ? 'assert(false)' : toStr(description));
});
def('debug_backtrace', (options = 1, limit = 0) => { const t = captureTrace(!(I(options) & 2)); t.delete(0); t.reindex(); const l = I(limit); return l > 0 ? PHPArray.from(t.values().slice(0, l)) : t; });
def('debug_print_backtrace', (options = 0, limit = 0) => { const t = captureTrace(!(I(options) & 2)); t.delete(0); t.reindex(); const s = traceAsString(t); rt.echo(s.slice(0, s.lastIndexOf('#')) ); });
def('gc_collect_cycles', () => 0);
def('gc_enable', () => null); def('gc_disable', () => null); def('gc_enabled', () => true); def('gc_mem_caches', () => 0);
def('set_time_limit', (seconds) => { setTimeLimit(I(seconds)); return true; });
def('ignore_user_abort', (enable = null) => 0);
def('connection_status', () => 0); def('connection_aborted', () => 0);
def('headers_sent', () => false); def('header', (header, replace = true, response_code = 0) => null); def('header_remove', (name = null) => null);
def('headers_list', () => new PHPArray());
def('http_response_code', (response_code = 0) => false);
def('setcookie', (name, ...rest) => true); def('setrawcookie', (name, ...rest) => true);
def('session_start', () => true); def('session_id', () => ''); def('session_destroy', () => true);
def('php_sapi_name', () => 'cli');
def('phpversion', (extension = null) => (extension === null ? PHP_VERSION : (['core', 'standard', 'json', 'ctype', 'mbstring', 'pcre', 'date', 'spl'].includes(S(extension).toLowerCase()) ? PHP_VERSION : false)));
def('php_uname', (mode = 'a') => { const m = S(mode); if (m === 's') return osMod.type(); if (m === 'n') return osMod.hostname(); if (m === 'r') return osMod.release(); if (m === 'm') return osMod.machine ? osMod.machine() : process.arch; if (m === 'v') return osMod.version ? osMod.version() : ''; return `${osMod.type()} ${osMod.hostname()} ${osMod.release()} ${osMod.version ? osMod.version() : ''} ${process.arch}`; });
def('php_ini_loaded_file', () => false);
def('php_ini_scanned_files', () => false);
def('zend_version', () => '4.3.' + PHP_VERSION.split('.')[2]);
def('extension_loaded', (extension) => ['core', 'standard', 'json', 'ctype', 'mbstring', 'pcre', 'date', 'spl', 'hash', 'random', 'reflection', 'tokenizer', 'iconv', 'filter'].includes(S(extension).toLowerCase()));
def('get_included_files', () => PHPArray.from([...rt.mainFile ? [rt.mainFile] : [], ...rt.included]));
alias('get_required_files', 'get_included_files');
def('get_loaded_extensions', (zend_extensions = false) => PHPArray.from(['Core', 'date', 'json', 'pcre', 'SPL', 'standard', 'ctype', 'mbstring', 'hash', 'random']));
def('dl', () => false);
def('getenv', (name = null, local_only = false) => {
  if (name === null) return PHPArray.fromPairs(Object.entries(process.env).map(([k, v]) => [k, v]));
  const v = process.env[S(name)]; return v === undefined ? false : utf8Encode(v);
});
def('putenv', (assignment) => { const s = S(assignment); const i = s.indexOf('='); if (i < 0) delete process.env[s]; else process.env[s.slice(0, i)] = s.slice(i + 1); return true; });
def('gethostname', () => osMod.hostname());
def('getmypid', () => process.pid);
def('getmyuid', () => (process.getuid ? process.getuid() : 0));
def('get_current_user', () => { try { return osMod.userInfo().username; } catch (e) { return ''; } });
def('memory_get_usage', (real_usage = false) => process.memoryUsage().heapUsed);
def('memory_get_peak_usage', (real_usage = false) => process.memoryUsage().heapTotal);
def('memory_reset_peak_usage', () => null);
def('getrusage', () => { const u = process.cpuUsage(); return PHPArray.fromPairs([['ru_utime.tv_sec', Math.floor(u.user / 1e6)], ['ru_utime.tv_usec', u.user % 1e6], ['ru_stime.tv_sec', Math.floor(u.system / 1e6)], ['ru_stime.tv_usec', u.system % 1e6]]); });
def('sys_getloadavg', () => PHPArray.from(osMod.loadavg().map(mkf)));
def('version_compare', (version1, version2, operator = null) => {
  const canon = (v) => {
    v = v.replace(/[-_+]/g, '.').replace(/([^\d.])(\d)/g, '$1.$2').replace(/(\d)([^\d.])/g, '$1.$2');
    return v.split('.').filter((x) => x !== '');
  };
  const order = (x) => { if (/^\d+$/.test(x)) return 10; const m = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, RC: 3, rc: 3, '#': 4, pl: 5, p: 5 }; return m[x] !== undefined ? m[x] : -1; };
  const a = canon(S(version1)), b = canon(S(version2));
  let r = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) { r = order(y) === 10 || order(y) >= 4 ? -1 : 1; break; }
    if (y === undefined) { r = order(x) === 10 || order(x) >= 4 ? 1 : -1; break; }
    const ox = order(x), oy = order(y);
    if (ox === 10 && oy === 10) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) { r = sgn(d); break; } }
    else if (ox !== oy) { r = sgn(ox - oy); break; }
  }
  if (operator === null) return r;
  switch (S(operator)) {
    case '<': case 'lt': return r < 0; case '<=': case 'le': return r <= 0;
    case '>': case 'gt': return r > 0; case '>=': case 'ge': return r >= 0;
    case '==': case 'eq': return r === 0; case '!=': case '<>': case 'ne': return r !== 0;
  }
  throwError('ValueError', 'version_compare(): Argument #3 ($operator) must be a valid comparison operator');
});
