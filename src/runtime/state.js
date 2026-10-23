// Global interpreter state (rt), error-level constants and low-level output.

import fs from 'node:fs';

export const E_ERROR = 1, E_WARNING = 2, E_PARSE = 4, E_NOTICE = 8, E_CORE_ERROR = 16, E_CORE_WARNING = 32, E_COMPILE_ERROR = 64,
  E_COMPILE_WARNING = 128, E_USER_ERROR = 256, E_USER_WARNING = 512, E_USER_NOTICE = 1024, E_STRICT = 2048,
  E_RECOVERABLE_ERROR = 4096, E_DEPRECATED = 8192, E_USER_DEPRECATED = 16384, E_ALL = 32767;

export const rt = {
  fns: new Map(), userFnNames: new Set(), classes: new Map(), consts: new Map(), constsCI: new Set(),
  globals: Object.create(null), frame: null, globalFrame: null, line: 0, file: '', stack: [], depth: 0,
  silence: 0, errorReporting: E_ALL & ~E_DEPRECATED & ~E_STRICT, displayErrors: 'stderr',
  precision: 14, serializePrecision: -1, errorHandlers: [], exceptionHandlers: [], shutdownFns: [], autoloaders: [],
  epoch: 0, hoisting: false, tickFns: [], tickCount: 0, currentFiber: null, suspendedFibers: new Set(), included: new Set(), progCache: new Map(), obStack: [], outBuf: '', capture: null, ini: new Map(), mainStrict: false,
  destructibles: [], tz: 'UTC', inHandler: false, lastError: null, exitCode: 0, startTime: Date.now(),
  echo(s) {
    if (s.length === 0) return;
    const ob = rt.obStack;
    if (ob.length) { ob[ob.length - 1].buf += s; return; }
    rt.outBuf += s;
    if (rt.outBuf.length > 65536 || rt.ttyOut) rt.flush();
  },
  flush() {
    if (!rt.outBuf) return;
    const s = rt.outBuf; rt.outBuf = '';
    if (rt.capture) { rt.capture.push(s); return; }
    writeFd(1, Buffer.from(s, 'latin1'));
  },
};

export function writeFd(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(fd, buf, off, buf.length - off); }
    catch (e) {
      if (e.code === 'EAGAIN') { sleepMs(1); continue; }
      if (e.code === 'EPIPE') return;
      throw e;
    }
  }
}
const sleepArr = new Int32Array(new SharedArrayBuffer(4));
export function sleepMs(ms) { if (ms > 0) Atomics.wait(sleepArr, 0, 0, ms); }
