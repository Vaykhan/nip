// Conversions between PHP byte strings and JS (UTF-16) strings.

export function utf8Decode(s) { // byte string -> JS unicode string
  let ascii = true;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) return s;
  return Buffer.from(s, 'latin1').toString('utf8');
}
export function utf8Encode(s) { // JS unicode string -> byte string
  let ascii = true;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) return s;
  return Buffer.from(s, 'utf8').toString('latin1');
}
export function isValidUtf8(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) {
    const b = Buffer.from(s, 'latin1');
    try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch (e) { return false; }
  }
  return true;
}
export const bytes = (s) => Buffer.from(s, 'latin1');
export const fromBytes = (b) => Buffer.from(b).toString('latin1');
