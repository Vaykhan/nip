// Files, directories and streams (fopen family, php:// streams, glob, process execution).

import fs from 'node:fs';
import cpMod from 'node:child_process';
import osMod from 'node:os';
import pathMod from 'node:path';
import crypto from 'node:crypto';
import tty from 'node:tty';
import { mkf, PHPArray, PHPResource, Ref } from '../values.js';
import { toBool, toStr, typeOf } from '../convert.js';
import { bytes, fromBytes } from '../utf8.js';
import { rt, sleepMs, writeFd } from '../runtime/state.js';
import { notice, throwError, warn } from '../runtime/errors.js';
import { callNative } from '../runtime/functions.js';
import { A, alias, def, deref, I, S } from './core.js';

class StreamH {
  constructor(kind, fd, path, mode) {
    this.kind = kind; this.fd = fd; this.path = path; this.mode = mode;
    this.pos = 0; this.eof = false; this.rbuf = ''; this.mem = ''; this.append = mode[0] === 'a';
    this.readable = /r|\+/.test(mode); this.writable = /[waxc]|\+/.test(mode);
    this.dirEntries = null;
  }
}
export function getStream(v) {
  if (v instanceof Ref) v = v.v;
  if (!(v instanceof PHPResource) || v.type !== 'stream') throwError('TypeError', `${rt.nativeName}(): Argument #1 ($stream) must be of type resource, ${typeOf(v)} given`);
  if (v.closed) throwError('TypeError', `${rt.nativeName}(): supplied resource is not a valid stream resource`);
  return v.h;
}
function mkStream(kind, fd, path, mode) { return new PHPResource('stream', new StreamH(kind, fd, path, mode)); }
export let STDIN_R, STDOUT_R, STDERR_R;
export function initStdStreams() {
  STDIN_R = mkStream('stdio', 0, 'php://stdin', 'r');
  STDOUT_R = mkStream('stdio', 1, 'php://stdout', 'w');
  STDERR_R = mkStream('stdio', 2, 'php://stderr', 'w');
  STDIN_R.id = 1; STDOUT_R.id = 2; STDERR_R.id = 3;
  PHPResource.n = 4;
}
function rawRead(h, n) {
  if (h.kind === 'mem') { const r = h.mem.slice(h.pos, h.pos + n); h.pos += r.length; if (h.pos >= h.mem.length) h.eof = r.length < n || h.pos >= h.mem.length; return r; }
  if (h.kind === 'output') return '';
  const buf = Buffer.alloc(n);
  let got;
  for (;;) {
    try { got = fs.readSync(h.fd, buf, 0, n, h.kind === 'file' ? h.pos : null); break; }
    catch (e) { if (e.code === 'EAGAIN') { sleepMs(5); continue; } if (e.code === 'EOF') { got = 0; break; } throw e; }
  }
  if (h.kind === 'file') h.pos += got;
  return buf.toString('latin1', 0, got);
}
function fillBuf(h, want) {
  while (h.rbuf.length < want) {
    const chunk = rawRead(h, Math.max(8192, want - h.rbuf.length));
    if (chunk === '') return false;
    h.rbuf += chunk;
  }
  return true;
}
export function streamReadLine(h, maxLen) {
  if (h.kind === 'stdio' && h.fd === 0) rt.flush();
  for (;;) {
    const nl = h.rbuf.indexOf('\n');
    if (nl >= 0 && (maxLen === null || nl + 1 <= maxLen)) { const line = h.rbuf.slice(0, nl + 1); h.rbuf = h.rbuf.slice(nl + 1); return line; }
    if (maxLen !== null && h.rbuf.length >= maxLen) { const line = h.rbuf.slice(0, maxLen); h.rbuf = h.rbuf.slice(maxLen); return line; }
    const chunk = h.kind === 'stdio' ? rawRead(h, 65536) : rawRead(h, 8192);
    if (chunk === '') {
      h.eof = true;
      if (h.rbuf === '') return false;
      const line = h.rbuf; h.rbuf = ''; return line;
    }
    h.rbuf += chunk;
  }
}
function streamRead(h, n) {
  if (h.kind === 'stdio' && h.fd === 0) rt.flush();
  if (h.rbuf.length < n) {
    const more = rawRead(h, Math.max(n - h.rbuf.length, h.kind === 'file' ? n - h.rbuf.length : 1));
    if (more === '') h.eof = true;
    h.rbuf += more;
  }
  const r = h.rbuf.slice(0, n); h.rbuf = h.rbuf.slice(n);
  if (h.kind === 'mem' && h.pos >= h.mem.length && !h.rbuf) h.eof = true;
  return r;
}
export function streamWrite(stream, data) {
  const h = getStream(stream);
  const s = toStr(data);
  if (h.kind === 'output') { rt.echo(s); return s.length; }
  if (h.kind === 'mem') {
    if (h.append) h.pos = h.mem.length;
    h.mem = h.mem.slice(0, h.pos) + s + h.mem.slice(h.pos + s.length);
    h.pos += s.length; return s.length;
  }
  if (h.kind === 'stdio') { rt.flush(); writeFd(h.fd, Buffer.from(s, 'latin1')); return s.length; }
  if (!h.writable) { notice(`fwrite(): Write of ${s.length} bytes failed with errno=9 Bad file descriptor`); return false; }
  const buf = Buffer.from(s, 'latin1');
  if (h.append) { fs.writeSync(h.fd, buf, 0, buf.length, null); h.pos = fs.fstatSync(h.fd).size; }
  else { fs.writeSync(h.fd, buf, 0, buf.length, h.pos - h.rbuf.length); h.pos = h.pos - h.rbuf.length + buf.length; h.rbuf = ''; }
  return buf.length;
}
function openStream(filename, mode) {
  const fn = filename;
  if (fn === 'php://stdin') return STDIN_R;
  if (fn === 'php://stdout') return mkStream('stdio', 1, fn, 'w');
  if (fn === 'php://stderr') return mkStream('stdio', 2, fn, 'w');
  if (fn === 'php://output') return mkStream('output', -1, fn, 'w');
  if (fn === 'php://memory' || fn.startsWith('php://temp')) return mkStream('mem', -1, fn, 'w+');
  if (fn === 'php://input') return mkStream('mem', -1, fn, 'r');
  if (/^(https?|ftp):\/\//i.test(fn)) { warn(`fopen(${fn}): Failed to open stream: network streams are not supported`); return false; }
  let p = fn.replace(/^file:\/\//, '');
  const m = mode.replace(/[bt]/g, '');
  const flagsMap = { r: 'r', 'r+': 'r+', w: 'w', 'w+': 'w+', a: 'a', 'a+': 'a+', x: 'wx', 'x+': 'wx+', c: fs.constants.O_WRONLY | fs.constants.O_CREAT, 'c+': fs.constants.O_RDWR | fs.constants.O_CREAT };
  if (!(m in flagsMap)) throwError('ValueError', `${rt.nativeName}(): Argument #2 ($mode) must be a valid mode`);
  try {
    const fd = fs.openSync(p, flagsMap[m]);
    const r = mkStream('file', fd, p, m);
    if (m[0] === 'a') r.h.pos = fs.fstatSync(fd).size;
    return r;
  } catch (e) {
    const msg = e.code === 'ENOENT' ? 'No such file or directory' : e.code === 'EACCES' ? 'Permission denied' : e.code === 'EEXIST' ? 'File exists' : e.code === 'EISDIR' ? 'Is a directory' : e.message;
    warn(`${rt.nativeName}(${fn}): Failed to open stream: ${msg}`);
    return false;
  }
}
def('fopen', (filename, mode, use_include_path = false, context = null) => openStream(S(filename), S(mode)));
def('fclose', (stream) => { const v = deref(stream); const h = getStream(v); if (h.kind === 'file') { try { fs.closeSync(h.fd); } catch (e) { /* ignore */ } } v.closed = true; return true; });
def('fgets', (stream, length = null) => { const h = getStream(stream); return streamReadLine(h, length === null ? null : Math.max(0, I(length) - 1)); });
def('fgetc', (stream) => { const h = getStream(stream); const c = streamRead(h, 1); return c === '' ? false : c; });
def('fread', (stream, length) => { const h = getStream(stream); const n = I(length); if (n <= 0) throwError('ValueError', 'fread(): Argument #2 ($length) must be greater than 0'); return streamRead(h, n); });
def('fwrite', (stream, data, length = null) => { let s = S(data); if (length !== null) s = s.slice(0, I(length)); return streamWrite(stream, s); });
alias('fputs', 'fwrite');
def('feof', (stream) => {
  const h = getStream(stream);
  if (h.rbuf.length) return false;
  if (h.kind === 'mem') return h.pos >= h.mem.length && h.eof;
  if (h.kind === 'file') { try { return h.eof || h.pos >= fs.fstatSync(h.fd).size && h.eof; } catch (e) { return true; } }
  return h.eof;
});
def('fflush', (stream) => { getStream(stream); rt.flush(); return true; });
def('ftell', (stream) => { const h = getStream(stream); return h.pos - h.rbuf.length; });
def('fseek', (stream, offset, whence = 0) => {
  const h = getStream(stream); const off = I(offset); const w = I(whence);
  const size = h.kind === 'mem' ? h.mem.length : h.kind === 'file' ? fs.fstatSync(h.fd).size : 0;
  const cur = h.pos - h.rbuf.length;
  const np = w === 0 ? off : w === 1 ? cur + off : size + off;
  if (np < 0) return -1;
  h.pos = np; h.rbuf = ''; h.eof = false;
  return 0;
});
def('rewind', (stream) => { const h = getStream(stream); h.pos = 0; h.rbuf = ''; h.eof = false; return true; });
def('ftruncate', (stream, size) => { const h = getStream(stream); if (h.kind === 'mem') { h.mem = h.mem.slice(0, I(size)).padEnd(I(size), '\0'); return true; } fs.ftruncateSync(h.fd, I(size)); return true; });
def('flock', (stream, operation, would_block = undefined) => true, { refs: [false, false, true] });
def('fstat', (stream) => { const h = getStream(stream); if (h.kind === 'mem') return PHPArray.fromPairs([['size', h.mem.length]]); return statArray(fs.fstatSync(h.fd)); });
def('stream_get_contents', (stream, length = null, offset = -1) => {
  const h = getStream(stream);
  if (I(offset) >= 0) { h.pos = I(offset); h.rbuf = ''; }
  let out = h.rbuf; h.rbuf = '';
  const lim = length === null ? Infinity : I(length);
  for (;;) { if (out.length >= lim) break; const c = rawRead(h, 65536); if (c === '') { h.eof = true; break; } out += c; }
  if (out.length > lim) { h.rbuf = out.slice(lim); out = out.slice(0, lim); }
  return out;
});
def('stream_get_line', (stream, length, ending = '') => {
  const h = getStream(stream); const e = S(ending);
  if (!e) return streamRead(h, I(length)) || false;
  for (;;) {
    const p = h.rbuf.indexOf(e);
    if (p >= 0) { const r = h.rbuf.slice(0, p); h.rbuf = h.rbuf.slice(p + e.length); return r; }
    const c = rawRead(h, 8192); if (c === '') { if (!h.rbuf) { h.eof = true; return false; } const r = h.rbuf; h.rbuf = ''; h.eof = true; return r; }
    h.rbuf += c;
  }
});
def('stream_get_meta_data', (stream) => { const h = getStream(stream); return PHPArray.fromPairs([['timed_out', false], ['blocked', true], ['eof', h.eof], ['wrapper_type', h.kind === 'file' ? 'plainfile' : 'PHP'], ['stream_type', h.kind === 'mem' ? 'MEMORY' : 'STDIO'], ['mode', h.mode], ['unread_bytes', 0], ['seekable', h.kind !== 'stdio'], ['uri', h.path]]); });
def('stream_isatty', (stream) => { const h = getStream(stream); try { return h.kind === 'stdio' && tty.isatty(h.fd); } catch (e) { return false; } });
alias('posix_isatty', 'stream_isatty');
def('stream_set_blocking', (stream, enable) => true);
def('stream_set_timeout', (stream, seconds, microseconds = 0) => true);
def('stream_context_create', (options = null, params = null) => new PHPResource('stream-context', {}));
def('stream_select', (read, write, except, seconds, microseconds = 0) => { const r = deref(read); return r instanceof PHPArray ? r.size : 0; }, { refs: [true, true, true] });
def('stream_get_wrappers', () => PHPArray.from(['php', 'file']));
def('fpassthru', (stream) => { const s = callNative(rt.fns.get('stream_get_contents'), [stream]); rt.echo(s); return s.length; });
def('fgetcsv', (stream, length = null, separator = ',', enclosure = '"', escape = '\\') => {
  const h = getStream(stream);
  let line = streamReadLine(h, null);
  if (line === false) return false;
  const sep = S(separator), encl = S(enclosure);
  // multi-line quoted fields
  while ((line.split(encl).length - 1) % 2 === 1) { const more = streamReadLine(h, null); if (more === false) break; line += more; }
  line = line.replace(/\r?\n$/, '');
  if (line === '') return PHPArray.from([null]);
  return PHPArray.from(parseCsvLine(line, sep, encl, S(escape)));
});
function parseCsvLine(line, sep, encl, escape) {
  const out = []; let cur = '', inQ = false, i = 0, quotedField = false;
  while (i < line.length) {
    const c = line[i];
    if (inQ) {
      if (escape && c === escape && escape !== encl && line[i + 1] === encl) { cur += c + encl; i += 2; continue; }
      if (c === encl) { if (line[i + 1] === encl) { cur += encl; i += 2; continue; } inQ = false; i++; continue; }
      cur += c; i++; continue;
    }
    if (c === encl && cur.trim() === '' ) { inQ = true; quotedField = true; cur = ''; i++; continue; }
    if (c === sep) { out.push(cur); cur = ''; quotedField = false; i++; continue; }
    cur += c; i++;
  }
  out.push(cur);
  void quotedField;
  return out;
}
function csvLine(fields, sep, encl, eol) {
  return fields.map((f) => {
    const s = toStr(f);
    if (s === '' ) return s;
    if (/[\s"\\,;]/.test(s) || s.includes(sep) || s.includes(encl)) return encl + s.split(encl).join(encl + encl) + encl;
    return s;
  }).join(sep) + eol;
}
def('fputcsv', (stream, fields, separator = ',', enclosure = '"', escape = '\\', eol = '\n') => streamWrite(stream, csvLine(A(fields).values(), S(separator), S(enclosure), S(eol))));
def('str_getcsv', (string, separator = ',', enclosure = '"', escape = '\\') => PHPArray.from(parseCsvLine(S(string), S(separator), S(enclosure), S(escape))));
def('readline', (prompt = null) => {
  if (prompt !== null) { rt.echo(S(prompt)); }
  rt.flush();
  const l = streamReadLine(STDIN_R.h, null);
  if (l === false) return false;
  return l.replace(/\r?\n$/, '');
});
def('readline_add_history', (prompt) => true);
def('readline_clear_history', () => true);
def('readline_write_history', () => true);
def('readline_read_history', () => true);

function fsErr(fn, p, e) {
  const msg = e.code === 'ENOENT' ? 'No such file or directory' : e.code === 'EACCES' ? 'Permission denied' : e.code === 'EEXIST' ? 'File exists' : e.code === 'ENOTEMPTY' ? 'Directory not empty' : e.code === 'EISDIR' ? 'Is a directory' : e.code === 'ENOTDIR' ? 'Not a directory' : e.message;
  return msg;
}
def('file_get_contents', (filename, use_include_path = false, context = null, offset = 0, length = null) => {
  const fn = S(filename);
  if (fn === 'php://stdin') { let out = STDIN_R.h.rbuf; STDIN_R.h.rbuf = ''; for (;;) { const c = rawRead(STDIN_R.h, 65536); if (c === '') break; out += c; } return out; }
  if (fn === 'php://input') return '';
  if (/^https?:\/\//i.test(fn)) {
    try { return fromBytes(cpMod.execFileSync('curl', ['-sSL', '--fail', fn], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 })); }
    catch (e) { warn(`file_get_contents(${fn}): Failed to open stream: HTTP request failed!`); return false; }
  }
  if (fn.startsWith('data:')) { const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(fn); if (m) return m[1] ? fromBytes(Buffer.from(m[2], 'base64')) : decodeURIComponent(m[2]); }
  try {
    let data = fs.readFileSync(fn.replace(/^file:\/\//, '')).toString('latin1');
    const off = I(offset);
    if (off) data = data.slice(off < 0 ? data.length + off : off);
    if (length !== null) data = data.slice(0, I(length));
    return data;
  } catch (e) {
    warn(`file_get_contents(${fn}): Failed to open stream: ${fsErr('file_get_contents', fn, e)}`);
    return false;
  }
});
def('file_put_contents', (filename, data, flags = 0, context = null) => {
  const fn = S(filename);
  let s;
  if (data instanceof PHPArray) s = data.values().map(toStr).join('');
  else if (data instanceof PHPResource) s = callNative(rt.fns.get('stream_get_contents'), [data]);
  else s = toStr(data);
  if (fn === 'php://stdout' || fn === 'php://output') { if (fn === 'php://output') rt.echo(s); else { rt.flush(); writeFd(1, bytes(s)); } return s.length; }
  if (fn === 'php://stderr') { rt.flush(); writeFd(2, bytes(s)); return s.length; }
  try {
    if (I(flags) & 8) fs.appendFileSync(fn, bytes(s)); else fs.writeFileSync(fn, bytes(s));
    return s.length;
  } catch (e) {
    warn(`file_put_contents(${fn}): Failed to open stream: ${fsErr('', fn, e)}`);
    return false;
  }
});
def('file', (filename, flags = 0, context = null) => {
  const c = callNative(rt.fns.get('file_get_contents'), [filename]);
  if (c === false) return false;
  const fl = I(flags);
  let lines = c.split(/(?<=\n)/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (fl & 2) lines = lines.map((l) => l.replace(/\r?\n$/, ''));
  if (fl & 4) lines = lines.filter((l) => l !== '');
  return PHPArray.from(lines);
});
def('readfile', (filename) => { const c = callNative(rt.fns.get('file_get_contents'), [filename]); if (c === false) return false; rt.echo(c); return c.length; });
const statOk = (p, fn) => { try { return fn(fs.statSync(p)); } catch (e) { return false; } };
def('file_exists', (filename) => { try { fs.accessSync(S(filename)); return true; } catch (e) { return false; } });
def('is_file', (filename) => statOk(S(filename), (s) => s.isFile()));
def('is_dir', (filename) => statOk(S(filename), (s) => s.isDirectory()));
def('is_link', (filename) => { try { return fs.lstatSync(S(filename)).isSymbolicLink(); } catch (e) { return false; } });
def('is_readable', (filename) => { try { fs.accessSync(S(filename), fs.constants.R_OK); return true; } catch (e) { return false; } });
def('is_writable', (filename) => { try { fs.accessSync(S(filename), fs.constants.W_OK); return true; } catch (e) { return false; } });
alias('is_writeable', 'is_writable');
def('is_executable', (filename) => { try { fs.accessSync(S(filename), fs.constants.X_OK); return statOk(S(filename), (s) => s.isFile()); } catch (e) { return false; } });
def('is_uploaded_file', (filename) => false);
def('move_uploaded_file', (from, to) => false);
function statFn(name, get) { def(name, (filename) => { try { return get(fs.statSync(S(filename))); } catch (e) { warn(`${name}(): stat failed for ${S(filename)}`); return false; } }); }
statFn('filesize', (s) => s.size);
statFn('filemtime', (s) => Math.floor(s.mtimeMs / 1000));
statFn('fileatime', (s) => Math.floor(s.atimeMs / 1000));
statFn('filectime', (s) => Math.floor(s.ctimeMs / 1000));
statFn('fileperms', (s) => s.mode);
statFn('fileinode', (s) => s.ino);
statFn('fileowner', (s) => s.uid);
statFn('filegroup', (s) => s.gid);
statFn('filetype', (s) => (s.isFile() ? 'file' : s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : s.isFIFO() ? 'fifo' : s.isCharacterDevice() ? 'char' : s.isBlockDevice() ? 'block' : 'unknown'));
function statArray(s) {
  const vals = [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.rdev, s.size, Math.floor(s.atimeMs / 1000), Math.floor(s.mtimeMs / 1000), Math.floor(s.ctimeMs / 1000), s.blksize, s.blocks];
  const names = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'atime', 'mtime', 'ctime', 'blksize', 'blocks'];
  const out = PHPArray.from(vals);
  names.forEach((n, i) => out.set(n, vals[i]));
  return out;
}
def('stat', (filename) => { try { return statArray(fs.statSync(S(filename))); } catch (e) { warn(`stat(): stat failed for ${S(filename)}`); return false; } });
def('lstat', (filename) => { try { return statArray(fs.lstatSync(S(filename))); } catch (e) { warn(`lstat(): Lstat failed for ${S(filename)}`); return false; } });
def('clearstatcache', (clear_realpath_cache = false, filename = '') => null);
def('touch', (filename, mtime = null, atime = null) => {
  const p = S(filename);
  try { if (!fs.existsSync(p)) fs.writeFileSync(p, ''); const mt = mtime === null ? Date.now() / 1000 : I(mtime); fs.utimesSync(p, atime === null ? mt : I(atime), mt); return true; }
  catch (e) { warn(`touch(): Unable to create file ${p} because ${fsErr('', p, e)}`); return false; }
});
def('unlink', (filename, context = null) => { const p = S(filename); try { fs.unlinkSync(p); return true; } catch (e) { warn(`unlink(${p}): ${fsErr('', p, e)}`); return false; } });
def('mkdir', (directory, permissions = 0o777, recursive = false, context = null) => { const p = S(directory); try { fs.mkdirSync(p, { recursive: toBool(recursive), mode: I(permissions) }); return true; } catch (e) { warn(`mkdir(): ${fsErr('', p, e)}`); return false; } });
def('rmdir', (directory, context = null) => { const p = S(directory); try { fs.rmdirSync(p); return true; } catch (e) { warn(`rmdir(${p}): ${fsErr('', p, e)}`); return false; } });
def('rename', (from, to, context = null) => { try { fs.renameSync(S(from), S(to)); return true; } catch (e) { warn(`rename(${S(from)},${S(to)}): ${fsErr('', '', e)}`); return false; } });
def('copy', (from, to, context = null) => { try { fs.copyFileSync(S(from), S(to)); return true; } catch (e) { warn(`copy(${S(from)}): Failed to open stream: ${fsErr('', '', e)}`); return false; } });
def('tempnam', (directory, prefix) => { const dir = S(directory) || osMod.tmpdir(); const p = pathMod.join(fs.existsSync(dir) ? dir : osMod.tmpdir(), S(prefix).slice(0, 63) + crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, 'x')); fs.writeFileSync(p, ''); return p; });
def('tmpfile', () => { const p = pathMod.join(osMod.tmpdir(), 'php' + crypto.randomBytes(6).toString('hex')); const fd = fs.openSync(p, 'w+'); try { fs.unlinkSync(p); } catch (e) { /* ignore */ } return mkStream('file', fd, p, 'w+'); });
def('sys_get_temp_dir', () => osMod.tmpdir());
def('realpath', (path) => { try { return fs.realpathSync(S(path) || '.'); } catch (e) { return false; } });
def('getcwd', () => process.cwd());
def('chdir', (directory) => { try { process.chdir(S(directory)); return true; } catch (e) { warn(`chdir(): ${fsErr('', '', e)} (errno 2)`); return false; } });
def('chmod', (filename, permissions) => { try { fs.chmodSync(S(filename), I(permissions)); return true; } catch (e) { warn(`chmod(): ${fsErr('', '', e)}`); return false; } });
def('chown', (filename, user) => true); def('chgrp', (filename, group) => true);
def('umask', (mask = null) => (mask === null ? process.umask() : process.umask(I(mask))));
def('symlink', (target, link) => { try { fs.symlinkSync(S(target), S(link)); return true; } catch (e) { warn(`symlink(): ${fsErr('', '', e)}`); return false; } });
def('link', (target, link) => { try { fs.linkSync(S(target), S(link)); return true; } catch (e) { return false; } });
def('readlink', (path) => { try { return fs.readlinkSync(S(path)); } catch (e) { warn(`readlink(): ${fsErr('', '', e)}`); return false; } });
def('disk_free_space', (directory) => { try { const s = fs.statfsSync(S(directory)); return mkf(s.bavail * s.bsize); } catch (e) { return false; } });
def('disk_total_space', (directory) => { try { const s = fs.statfsSync(S(directory)); return mkf(s.blocks * s.bsize); } catch (e) { return false; } });
def('basename', (path, suffix = '') => {
  let p = S(path).replace(/\/+$/, '');
  if (p === '' && S(path).startsWith('/')) return '';
  let b = p.slice(p.lastIndexOf('/') + 1);
  const sf = S(suffix);
  if (sf && b.endsWith(sf) && b !== sf) b = b.slice(0, -sf.length);
  return b;
});
def('dirname', (path, levels = 1) => {
  let p = S(path);
  if (p === '') return '';
  if (I(levels) < 1) throwError('ValueError', 'dirname(): Argument #2 ($levels) must be greater than or equal to 1');
  for (let i = 0; i < I(levels); i++) {
    if (p === '/' ) return '/';
    p = p.replace(/\/+$/, '');
    const idx = p.lastIndexOf('/');
    if (idx < 0) return '.';
    p = idx === 0 ? '/' : p.slice(0, idx).replace(/\/+$/, '') || '/';
  }
  return p;
});
def('pathinfo', (path, flags = 15) => {
  const p = S(path); const out = new PHPArray(); const fl = I(flags);
  const idx = p.lastIndexOf('/');
  const base = p.slice(idx + 1);
  if (fl & 1 && p.includes('/')) out.set('dirname', idx === 0 ? '/' : p.slice(0, idx));
  else if (fl & 1 && base) out.set('dirname', '.');
  if (fl & 2) out.set('basename', base);
  const dot = base.lastIndexOf('.');
  if (fl & 4 && dot >= 0) out.set('extension', base.slice(dot + 1));
  if (fl & 8) out.set('filename', dot >= 0 ? base.slice(0, dot) : base);
  if (fl !== 15) { const v = out.values(); return v.length ? v[0] : ''; }
  return out;
});
def('fnmatch', (pattern, filename, flags = 0) => globToRe(S(pattern), I(flags) & 16).test(S(filename)));
function globToRe(g, ci) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const e = g.indexOf(']', i); if (e < 0) { re += '\\['; continue; } let cls = g.slice(i + 1, e); if (cls[0] === '!') cls = '^' + cls.slice(1); re += '[' + cls.replace(/\\/g, '\\\\') + ']'; i = e; }
    else if (c === '\\' && i + 1 < g.length) { re += '\\' + g[++i]; }
    else re += c.replace(/[.+^${}()|/\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ci ? 'i' : '');
}
function expandBraces(p) {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1].split(',').flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}
def('glob', (pattern, flags = 0) => {
  const fl = I(flags);
  const pats = (fl & 1024) ? expandBraces(S(pattern)) : [S(pattern)];
  const results = [];
  for (const pat of pats) {
    const abs = pat.startsWith('/');
    const parts = pat.split('/').filter((x, i) => x !== '' || i === 0);
    let paths = [abs ? '/' : ''];
    for (let i = abs ? 1 : 0; i < parts.length; i++) {
      const part = parts[i];
      const next = [];
      for (const base of paths) {
        if (!/[*?[]/.test(part)) { const np = base === '' ? part : base === '/' ? '/' + part : base + '/' + part; if (fs.existsSync(np)) next.push(np); continue; }
        const dir = base === '' ? '.' : base;
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch (e) { continue; }
        const re = globToRe(part, false);
        for (const en of entries.sort()) { if (en[0] === '.' && part[0] !== '.') continue; if (re.test(en)) next.push(base === '' ? en : base === '/' ? '/' + en : base + '/' + en); }
      }
      paths = next;
    }
    for (const p of paths) {
      if (fl & 8192) { try { if (!fs.statSync(p).isDirectory()) continue; } catch (e) { continue; } }
      results.push((fl & 2) && statOk(p, (s) => s.isDirectory()) ? p + '/' : p);
    }
  }
  if (!(fl & 4)) results.sort();
  return PHPArray.from(results);
});
def('scandir', (directory, sorting_order = 0, context = null) => {
  try {
    const e = ['.', '..', ...fs.readdirSync(S(directory))];
    e.sort(); if (I(sorting_order) === 1) e.reverse();
    return PHPArray.from(e);
  } catch (err) { warn(`scandir(${S(directory)}): Failed to open directory: ${fsErr('', '', err)}`); warn('scandir(): (errno 2): No such file or directory'); return false; }
});
def('opendir', (directory, context = null) => {
  try { const e = ['.', '..', ...fs.readdirSync(S(directory))]; const r = new PHPResource('stream', new StreamH('dir', -1, S(directory), 'r')); r.h.dirEntries = e; r.h.pos = 0; return r; }
  catch (e) { warn(`opendir(${S(directory)}): Failed to open directory: ${fsErr('', '', e)}`); return false; }
});
def('readdir', (dir_handle = null) => { const h = getStream(dir_handle); if (h.pos >= h.dirEntries.length) return false; return h.dirEntries[h.pos++]; });
def('rewinddir', (dir_handle = null) => { const h = getStream(dir_handle); h.pos = 0; });
def('closedir', (dir_handle = null) => { deref(dir_handle).closed = true; });
def('fileno', (stream) => getStream(stream).fd);
def('escapeshellarg', (arg) => "'" + S(arg).replace(/'/g, "'\\''") + "'");
def('escapeshellcmd', (command) => S(command).replace(/([#&;`|*?~<>^()[\]{}$\\\x0A\xFF"'])/g, '\\$1'));
function runShell(cmd, opts) { rt.flush(); try { return { out: cpMod.execSync(cmd, Object.assign({ stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 1 << 30, shell: '/bin/sh' }, opts || {})), code: 0 }; } catch (e) { return { out: e.stdout || Buffer.alloc(0), code: e.status === null ? 1 : e.status }; } }
def('shell_exec', (command) => { const r = runShell(S(command)); const s = fromBytes(r.out); return s === '' ? null : s; });
def('exec', (command, output = undefined, result_code = undefined) => {
  const r = runShell(S(command)); const s = fromBytes(r.out);
  const lines = s.replace(/\n$/, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  if (s === '') lines.length = 0;
  if (output instanceof Ref) { const a = output.v instanceof PHPArray ? output.v.clone() : new PHPArray(); for (const l of lines) a.push(l); output.v = a; }
  if (result_code instanceof Ref) result_code.v = r.code;
  return lines.length ? lines[lines.length - 1] : '';
}, { refs: [false, true, true] });
def('system', (command, result_code = undefined) => { const r = runShell(S(command)); const s = fromBytes(r.out); rt.echo(s); if (result_code instanceof Ref) result_code.v = r.code; return s.replace(/\n$/, '').split('\n').pop(); }, { refs: [false, true] });
def('passthru', (command, result_code = undefined) => { rt.flush(); let code = 0; try { cpMod.execSync(S(command), { stdio: 'inherit', shell: '/bin/sh' }); } catch (e) { code = e.status || 1; } if (result_code instanceof Ref) result_code.v = code; return null; }, { refs: [false, true] });
def('proc_nice', (priority) => true);
def('popen', (command, mode) => { const r = runShell(S(command)); const st = mkStream('mem', -1, 'popen', 'r'); st.h.mem = fromBytes(r.out); return st; });
def('pclose', (handle) => 0);
