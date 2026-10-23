// Output buffering (ob_*).

import { PHPArray } from '../values.js';
import { toStr } from '../convert.js';
import { rt } from '../runtime/state.js';
import { notice } from '../runtime/errors.js';
import { callableName, callValue } from '../runtime/callables.js';
import { def } from './core.js';

def('ob_start', (callback = null, chunk_size = 0, flags = 112) => { rt.obStack.push({ buf: '', cb: callback, started: false }); return true; });
export function obApply(ob, s, mode) {
  if (ob.cb === null || ob.cb === undefined) return s;
  if (!ob.started) { mode |= 1; ob.started = true; }
  if (ob.inHandler) return s;
  ob.inHandler = true;
  let r;
  try { r = callValue(ob.cb, [s, mode]); } finally { ob.inHandler = false; }
  return r === false ? s : toStr(r);
}
export function obEmit(s) { const ob = rt.obStack; if (ob.length) ob[ob.length - 1].buf += s; else rt.echo(s); }
def('ob_get_clean', () => { if (!rt.obStack.length) return false; const ob = rt.obStack[rt.obStack.length - 1]; obApply(ob, ob.buf, 2 | 8); rt.obStack.pop(); return ob.buf; });
def('ob_get_contents', () => (rt.obStack.length ? rt.obStack[rt.obStack.length - 1].buf : false));
def('ob_get_length', () => (rt.obStack.length ? rt.obStack[rt.obStack.length - 1].buf.length : false));
def('ob_get_level', () => rt.obStack.length);
def('ob_end_clean', () => { if (!rt.obStack.length) { notice('ob_end_clean(): Failed to delete buffer. No buffer to delete'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; try { obApply(ob, ob.buf, 2 | 8); } finally { rt.obStack.pop(); } return true; });
def('ob_clean', () => { if (!rt.obStack.length) { notice('ob_clean(): Failed to delete buffer. No buffer to delete'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; obApply(ob, ob.buf, 2); ob.buf = ''; return true; });
def('ob_end_flush', () => { if (!rt.obStack.length) { notice('ob_end_flush(): Failed to delete and flush buffer. No buffer to delete or flush'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; const out = obApply(ob, ob.buf, 8); rt.obStack.pop(); obEmit(out); return true; });
def('ob_get_flush', () => { if (!rt.obStack.length) return false; const ob = rt.obStack[rt.obStack.length - 1]; const out = obApply(ob, ob.buf, 8); rt.obStack.pop(); obEmit(out); return ob.buf; });
def('ob_flush', () => { if (!rt.obStack.length) { notice('ob_flush(): Failed to flush buffer. No buffer to flush'); return false; } const ob = rt.obStack[rt.obStack.length - 1]; const out = obApply(ob, ob.buf, 4); ob.buf = ''; rt.obStack.pop(); obEmit(out); rt.obStack.push(ob); return true; });
def('ob_implicit_flush', (enable = true) => null);
def('ob_list_handlers', () => PHPArray.from(rt.obStack.map((o) => (o.cb ? callableName(o.cb) : 'default output handler'))));
def('ob_get_status', () => new PHPArray());
def('flush', () => { if (!rt.obStack.length) rt.flush(); });
def('output_add_rewrite_var', () => true);
