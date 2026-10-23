// Date and time: date, mktime, strtotime, time zones (via ICU).

import { mkf, normBig, PHPArray } from '../values.js';
import { toBool, toInt } from '../convert.js';
import { rt, sleepMs } from '../runtime/state.js';
import { notice } from '../runtime/errors.js';
import { alias, def, I, N, S } from './core.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const tzFmtCache = new Map();
function validTz(tz) {
  if (/^(utc|gmt|z)$/i.test(tz)) return true;
  if (/^[+-]\d{2}:?\d{2}$/.test(tz)) return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
function tzInfo(ts, tz) {
  const ms = Math.floor(ts) * 1000;
  let m;
  if (!tz || /^(utc|gmt|z)$/i.test(tz) || (m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz))) {
    const off = m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60) : 0;
    const d = new Date(ms + off * 1000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay(), offset: off, abbr: m ? (m[1] + m[2] + ':' + m[3]) : 'UTC', dst: 0 };
  }
  let fmt = tzFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', timeZoneName: 'short', era: 'short' });
    tzFmtCache.set(tz, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  let y = parseInt(parts.year, 10); if (parts.era === 'BC' || parts.era === 'B') y = 1 - y;
  const r = { y, mo: parseInt(parts.month, 10), d: parseInt(parts.day, 10), h: parseInt(parts.hour, 10) % 24, mi: parseInt(parts.minute, 10), s: parseInt(parts.second, 10) };
  const asUtc = utcMs(r.y, r.mo, r.d, r.h, r.mi, r.s);
  r.offset = Math.round((asUtc - ms) / 1000);
  r.dow = new Date(asUtc).getUTCDay();
  let ab = parts.timeZoneName || '';
  if (/^GMT[+-]/.test(ab)) { const alt = tzAbbrGB(tz, ms); if (alt && !/^GMT[+-]|^UTC[+-]/.test(alt)) ab = alt; }
  const gm = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(ab);
  if (gm) ab = gm[1] + gm[2].padStart(2, '0') + (gm[3] ? gm[3] : '');
  else if (ab === 'GMT' && tz !== 'Europe/London' && tz !== 'GMT') ab = r.offset === 0 ? 'GMT' : ab;
  r.abbr = ab;
  // DST detection: compare with standard offset (min of Jan/Jul)
  const jan = tzOffsetAt(utcMs(r.y, 1, 1, 0, 0, 0), tz), jul = tzOffsetAt(utcMs(r.y, 7, 1, 0, 0, 0), tz);
  r.dst = r.offset > Math.min(jan, jul) ? 1 : 0;
  return r;
}
const tzGBCache = new Map();
function tzAbbrGB(tz, ms) {
  let f = tzGBCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }); tzGBCache.set(tz, f); }
  const p = f.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName');
  return p ? p.value : null;
}
function tzOffsetAt(ms, tz) {
  let fmt = tzFmtCache.get(tz);
  if (!fmt) { tzInfo(ms / 1000, tz); fmt = tzFmtCache.get(tz); }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  let y = parseInt(parts.year, 10); if (parts.era === 'BC' || parts.era === 'B') y = 1 - y;
  return Math.round((utcMs(y, parseInt(parts.month, 10), parseInt(parts.day, 10), parseInt(parts.hour, 10) % 24, parseInt(parts.minute, 10), parseInt(parts.second, 10)) - ms) / 1000);
}
function utcMs(y, mo, d, h, mi, s) { const dt = new Date(0); dt.setUTCFullYear(y, mo - 1, d); dt.setUTCHours(h, mi, s, 0); return dt.getTime(); }
function localToTs(y, mo, d, h, mi, s, tz) {
  const guess = utcMs(y, mo, d, h, mi, s) / 1000;
  const off1 = tzInfo(guess, tz).offset;
  let ts = guess - off1;
  const off2 = tzInfo(ts, tz).offset;
  if (off2 !== off1) ts = guess - off2;
  return ts;
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
function isoWeek(y, mo, d) {
  const dt = new Date(utcMs(y, mo, d, 0, 0, 0));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow + 3);
  const wy = dt.getUTCFullYear();
  const firstThu = new Date(utcMs(wy, 1, 4, 0, 0, 0));
  const fdow = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fdow + 3);
  return [wy, 1 + Math.round((dt - firstThu) / 604800000)];
}
function phpDate(format, ts, tz, micro) {
  const t = tzInfo(ts, tz);
  const p2 = (n) => String(n).padStart(2, '0');
  const offStr = (sep) => { const o = t.offset; const s = o < 0 ? '-' : '+'; const a = Math.abs(o); return s + p2(Math.floor(a / 3600)) + sep + p2(Math.floor((a % 3600) / 60)); };
  const doy = Math.round((utcMs(t.y, t.mo, t.d, 0, 0, 0) - utcMs(t.y, 1, 1, 0, 0, 0)) / 86400000);
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    switch (c) {
      case 'd': out += p2(t.d); break;
      case 'D': out += DAY_NAMES[t.dow].slice(0, 3); break;
      case 'j': out += t.d; break;
      case 'l': out += DAY_NAMES[t.dow]; break;
      case 'N': out += t.dow === 0 ? 7 : t.dow; break;
      case 'S': out += (t.d % 10 === 1 && t.d !== 11) ? 'st' : (t.d % 10 === 2 && t.d !== 12) ? 'nd' : (t.d % 10 === 3 && t.d !== 13) ? 'rd' : 'th'; break;
      case 'w': out += t.dow; break;
      case 'z': out += doy; break;
      case 'W': out += p2(isoWeek(t.y, t.mo, t.d)[1]); break;
      case 'F': out += MONTH_NAMES[t.mo - 1]; break;
      case 'm': out += p2(t.mo); break;
      case 'M': out += MONTH_NAMES[t.mo - 1].slice(0, 3); break;
      case 'n': out += t.mo; break;
      case 't': out += daysInMonth(t.y, t.mo); break;
      case 'L': out += isLeap(t.y) ? 1 : 0; break;
      case 'o': out += isoWeek(t.y, t.mo, t.d)[0]; break;
      case 'X': case 'x': out += (t.y < 0 ? '-' : (c === 'X' || t.y >= 10000 ? '+' : '')) + String(Math.abs(t.y)).padStart(4, '0'); break;
      case 'Y': out += (t.y < 0 ? '-' : '') + String(Math.abs(t.y)).padStart(4, '0'); break;
      case 'y': out += p2(Math.abs(t.y) % 100); break;
      case 'a': out += t.h < 12 ? 'am' : 'pm'; break;
      case 'A': out += t.h < 12 ? 'AM' : 'PM'; break;
      case 'B': { const b = Math.floor((((ts + 3600) % 86400) + 86400) % 86400 / 86.4); out += String(b).padStart(3, '0'); break; }
      case 'g': out += (t.h % 12) || 12; break;
      case 'G': out += t.h; break;
      case 'h': out += p2((t.h % 12) || 12); break;
      case 'H': out += p2(t.h); break;
      case 'i': out += p2(t.mi); break;
      case 's': out += p2(t.s); break;
      case 'u': out += String(micro || 0).padStart(6, '0'); break;
      case 'v': out += String(Math.floor((micro || 0) / 1000)).padStart(3, '0'); break;
      case 'e': out += tz; break;
      case 'I': out += t.dst; break;
      case 'O': out += offStr(''); break;
      case 'P': out += offStr(':'); break;
      case 'p': out += t.offset === 0 ? 'Z' : offStr(':'); break;
      case 'T': out += /^[A-Z]/.test(t.abbr) ? t.abbr : offStr(':').replace(/:00$/, '').replace(':', ''); break;
      case 'Z': out += t.offset; break;
      case 'c': out += phpDate('Y-m-d\\TH:i:sP', ts, tz); break;
      case 'r': out += phpDate('D, d M Y H:i:s O', ts, tz); break;
      case 'U': out += Math.floor(ts); break;
      case '\\': i++; if (i < format.length) out += format[i]; break;
      default: out += c;
    }
  }
  return out;
}
const nowTs = () => Math.floor(Date.now() / 1000);
def('time', () => nowTs());
def('microtime', (as_float = false) => {
  const t = performance.timeOrigin + performance.now();
  if (toBool(as_float)) return mkf(t / 1000);
  const sec = Math.floor(t / 1000); const us = (t / 1000 - sec);
  return us.toFixed(8) + ' ' + sec;
});
def('hrtime', (as_number = false) => {
  const t = process.hrtime.bigint();
  if (toBool(as_number)) return normBig(t);
  return PHPArray.from([Number(t / 1000000000n), Number(t % 1000000000n)]);
});
def('date', (format, timestamp = null) => phpDate(S(format), timestamp === null ? nowTs() : I(timestamp), rt.tz));
def('gmdate', (format, timestamp = null) => phpDate(S(format), timestamp === null ? nowTs() : I(timestamp), 'UTC'));
def('idate', (format, timestamp = null) => toInt(phpDate(S(format) === 'y' ? 'y' : S(format), timestamp === null ? nowTs() : I(timestamp), rt.tz)));
function mktimeImpl(args, tz) {
  const t = tzInfo(nowTs(), tz);
  const g = (i, d) => (args[i] === undefined || args[i] === null ? d : toInt(args[i]));
  let y = g(5, t.y);
  if (args[5] !== undefined && args[5] !== null) { if (y >= 0 && y < 70) y += 2000; else if (y >= 70 && y <= 100) y += 1900; }
  return localToTs(y, g(3, t.mo), g(4, t.d), g(0, t.h), g(1, t.mi), g(2, t.s), tz);
}
def('mktime', (hour = null, minute = null, second = null, month = null, day = null, year = null) => mktimeImpl([hour, minute, second, month, day, year], rt.tz));
def('gmmktime', (hour = null, minute = null, second = null, month = null, day = null, year = null) => mktimeImpl([hour, minute, second, month, day, year], 'UTC'));
def('checkdate', (month, day, year) => { const m = I(month), d = I(day), y = I(year); return m >= 1 && m <= 12 && d >= 1 && y >= 1 && y <= 32767 && d <= daysInMonth(y, m); });
def('date_default_timezone_set', (timezoneId) => { const tz = S(timezoneId); if (!validTz(tz)) { notice(`date_default_timezone_set(): Timezone ID '${tz}' is invalid`); return false; } rt.tz = tz; return true; });
def('date_default_timezone_get', () => rt.tz);
def('getdate', (timestamp = null) => {
  const ts = timestamp === null ? nowTs() : I(timestamp); const t = tzInfo(ts, rt.tz);
  const doy = Math.round((utcMs(t.y, t.mo, t.d, 0, 0, 0) - utcMs(t.y, 1, 1, 0, 0, 0)) / 86400000);
  return PHPArray.fromPairs([['seconds', t.s], ['minutes', t.mi], ['hours', t.h], ['mday', t.d], ['wday', t.dow], ['mon', t.mo], ['year', t.y], ['yday', doy], ['weekday', DAY_NAMES[t.dow]], ['month', MONTH_NAMES[t.mo - 1]], [0, ts]]);
});
def('localtime', (timestamp = null, associative = false) => {
  const ts = timestamp === null ? nowTs() : I(timestamp); const t = tzInfo(ts, rt.tz);
  const doy = Math.round((utcMs(t.y, t.mo, t.d, 0, 0, 0) - utcMs(t.y, 1, 1, 0, 0, 0)) / 86400000);
  const vals = [t.s, t.mi, t.h, t.d, t.mo - 1, t.y - 1900, t.dow, doy, t.dst];
  if (!toBool(associative)) return PHPArray.from(vals);
  return PHPArray.fromPairs(['tm_sec', 'tm_min', 'tm_hour', 'tm_mday', 'tm_mon', 'tm_year', 'tm_wday', 'tm_yday', 'tm_isdst'].map((k, i) => [k, vals[i]]));
});
def('cal_days_in_month', (calendar, month, year) => daysInMonth(I(year), I(month)));
def('strftime', (format, timestamp = null) => {
  const ts = timestamp === null ? nowTs() : I(timestamp);
  const map = { a: 'D', A: 'l', d: 'd', e: 'j', j: 'z', u: 'N', w: 'w', U: 'W', V: 'W', W: 'W', b: 'M', B: 'F', h: 'M', m: 'm', y: 'y', Y: 'Y', G: 'o', H: 'H', I: 'h', l: 'g', M: 'i', p: 'A', P: 'a', r: 'h:i:s A', R: 'H:i', S: 's', T: 'H:i:s', X: 'H:i:s', z: 'O', Z: 'T', c: 'D M j H:i:s Y', D: 'm/d/y', F: 'Y-m-d', s: 'U', x: 'm/d/y', n: '\n', t: '\t', '%': '%' };
  return S(format).replace(/%([a-zA-Z%])/g, (m, c) => (map[c] ? (c === 'n' || c === 't' || c === '%' ? map[c] : (c === 'e' ? phpDate('j', ts, rt.tz).padStart(2, ' ') : phpDate(map[c], ts, rt.tz))) : m));
});
alias('gmstrftime', 'strftime');
def('usleep', (microseconds) => { rt.flush(); sleepMs(I(microseconds) / 1000); });
def('sleep', (seconds) => { rt.flush(); sleepMs(I(seconds) * 1000); return 0; });
def('time_nanosleep', (seconds, nanoseconds) => { rt.flush(); sleepMs(I(seconds) * 1000 + I(nanoseconds) / 1e6); return true; });
def('time_sleep_until', (timestamp) => { rt.flush(); sleepMs(N(timestamp) * 1000 - Date.now()); return true; });
def('gettimeofday', (as_float = false) => {
  const t = Date.now();
  if (toBool(as_float)) return mkf(t / 1000);
  return PHPArray.fromPairs([['sec', Math.floor(t / 1000)], ['usec', (t % 1000) * 1000], ['minuteswest', -tzInfo(t / 1000, rt.tz).offset / 60], ['dsttime', 0]]);
});

const MONTHS_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS_RE = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const monthNum = (s) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase()) + 1;
const dayNum = (s) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(s.slice(0, 3).toLowerCase());
const REL_UNITS = { sec: 's', secs: 's', second: 's', seconds: 's', min: 'mi', mins: 'mi', minute: 'mi', minutes: 'mi', hour: 'h', hours: 'h', day: 'd', days: 'd', week: 'w', weeks: 'w', fortnight: 'f', fortnights: 'f', month: 'mo', months: 'mo', year: 'y', years: 'y', weekday: 'wd', weekdays: 'wd', msec: 'ms', millisecond: 'ms', milliseconds: 'ms', usec: 'us', microsecond: 'us', microseconds: 'us' };
function strToTime(input, base, tz) {
  let s = input.trim().toLowerCase();
  if (s === '') return false;
  const b = tzInfo(base, tz);
  let y = b.y, mo = b.mo, d = b.d, h = b.h, mi = b.mi, sec = b.s;
  let timeSet = false, dateSet = false, absTs = null, zoneOff = null, zone = null;
  const rel = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0, wd: 0 };
  let weekday = null, weekdayDir = 0, firstLast = null;
  const tzFromStr = (z) => {
    if (z === 'z' || z === 'utc' || z === 'gmt') return 0;
    const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(z);
    if (m) return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0));
    return null;
  };
  const setTime = (H, M, S2, ampm) => {
    H = parseInt(H, 10); M = M ? parseInt(M, 10) : 0; S2 = S2 ? parseInt(S2, 10) : 0;
    if (ampm) { const pm = ampm[0] === 'p'; if (H === 12) H = pm ? 12 : 0; else if (pm) H += 12; }
    h = H; mi = M; sec = S2; timeSet = true;
  };
  const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, next: 1, last: -1, previous: -1, this: 0 };
  const pats = [
    [/^@(-?\d+)(?:\.\d+)?/, (m) => { absTs = parseInt(m[1], 10); }],
    [/^(now)\b/, () => {}],
    [/^(today|midnight)\b/, () => { h = mi = sec = 0; timeSet = true; }],
    [/^noon\b/, () => { h = 12; mi = sec = 0; timeSet = true; }],
    [/^tomorrow\b/, () => { rel.d += 1; h = mi = sec = 0; timeSet = true; }],
    [/^yesterday\b/, () => { rel.d -= 1; h = mi = sec = 0; timeSet = true; }],
    [/^(\d{4})-(\d{1,2})-(\d{1,2})[t ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; setTime(m[4], m[5], m[6]); }],
    [/^(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; }],
    [/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; }],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/, (m) => { mo = +m[1]; d = +m[2]; y = +m[3]; if (m[3].length === 2) y += y < 70 ? 2000 : 1900; dateSet = true; }],
    [/^(\d{1,2})\/(\d{1,2})\b/, (m) => { mo = +m[1]; d = +m[2]; dateSet = true; }],
    [/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})\b/, (m) => { d = +m[1]; mo = +m[2]; y = +m[3]; dateSet = true; }],
    [/^(\d{4})(\d{2})(\d{2})(?:t?(\d{2}):?(\d{2}):?(\d{2}))?(?!\d)/, (m) => { y = +m[1]; mo = +m[2]; d = +m[3]; dateSet = true; if (m[4]) setTime(m[4], m[5], m[6]); }],
    [new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?[ \\-.]*(${MONTHS_RE})\\.?(?:[ \\-.,]+(\\d{4}))?\\b`), (m) => { d = +m[1]; mo = monthNum(m[2]); if (m[3]) y = +m[3]; dateSet = true; }],
    [new RegExp(`^(${MONTHS_RE})\\.?[ \\-.]*(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\-.]*(\\d{4}))?\\b`), (m) => { mo = monthNum(m[1]); d = +m[2]; if (m[3]) y = +m[3]; dateSet = true; }],
    [new RegExp(`^(${MONTHS_RE})\\.?[ \\-.]*(\\d{4})\\b`), (m) => { mo = monthNum(m[1]); y = +m[2]; d = 1; dateSet = true; }],
    [new RegExp(`^(${MONTHS_RE})\\b`), (m) => { mo = monthNum(m[1]); dateSet = true; }],
    [/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([ap]\.?m\.?)?/, (m) => { setTime(m[1], m[2], m[3], m[5] ? m[5].replace(/\./g, '') : null); }],
    [/^(\d{1,2})\s*([ap]\.?m\.?)/, (m) => { setTime(m[1], 0, 0, m[2].replace(/\./g, '')); }],
    [/^t(\d{2}):?(\d{2}):?(\d{2})?/, (m) => setTime(m[1], m[2], m[3])],
    [/^(first|last) day of\b/, (m) => { firstLast = m[1]; }],
    [new RegExp(`^(next|last|previous|this)\\s+(${DAYS_RE})\\b`), (m) => { weekday = dayNum(m[2]); weekdayDir = m[1] === 'next' ? 1 : m[1] === 'this' ? 0 : -1; }],
    [/^(next|last|previous|this)\s+(sec|second|min|minute|hour|day|week|fortnight|month|year)\b/, (m) => { const n = NUMW[m[1]]; addRel(n, m[2]); }],
    [/^([+-]?\s*\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(secs?|seconds?|mins?|minutes?|hours?|days?|weeks?|fortnights?|months?|years?|weekdays?|msec|milliseconds?|usec|microseconds?)\b/, (m) => { const n = NUMW[m[1]] !== undefined ? NUMW[m[1]] : parseInt(m[1].replace(/\s+/g, ''), 10); addRel(n, m[2]); }],
    [/^ago\b/, () => { for (const k of Object.keys(rel)) rel[k] = -rel[k]; }],
    [new RegExp(`^(${DAYS_RE})\\b`), (m) => { weekday = dayNum(m[1]); weekdayDir = 0; }],
    [/^(z|utc|gmt)\b/, (m) => { zoneOff = 0; }],
    [/^([+-]\d{2}):?(\d{2})\b/, (m) => { zoneOff = tzFromStr(m[1] + m[2]); }],
    [/^([a-z]+\/[a-z_]+(?:\/[a-z_]+)?)/, (m) => { const zn = input.trim().slice(input.trim().toLowerCase().indexOf(m[1]), input.trim().toLowerCase().indexOf(m[1]) + m[1].length); if (validTz(zn)) zone = zn; else throw new Error('bad'); }],
    [/^(\d{4})\b/, (m) => { if (timeSet || dateSet) { y = +m[1]; } else { setTime(m[1].slice(0, 2), m[1].slice(2)); } }],
    [/^[\s,]+/, () => {}],
  ];
  function addRel(n, unit) {
    const u = REL_UNITS[unit] || REL_UNITS[unit.replace(/s$/, '')];
    if (u === 'w') rel.d += 7 * n; else if (u === 'f') rel.d += 14 * n; else if (u === 'wd') rel.wd += n; else if (u === 'ms' || u === 'us') { /* ignore sub-second */ } else rel[u] += n;
  }
  let pos = 0;
  try {
    while (pos < s.length) {
      const rest = s.slice(pos);
      let matched = false;
      for (const [re, fn] of pats) {
        const m = re.exec(rest);
        if (m && m[0].length) { fn(m); pos += m[0].length; matched = true; break; }
      }
      if (!matched) return false;
    }
  } catch (e) { return false; }
  if (absTs !== null) {
    const t2 = tzInfo(absTs, 'UTC');
    y = t2.y; mo = t2.mo; d = t2.d; h = t2.h; mi = t2.mi; sec = t2.s; zoneOff = 0;
  }
  if (dateSet && !timeSet) { h = mi = sec = 0; }
  y += rel.y; mo += rel.mo;
  // normalize month
  while (mo > 12) { mo -= 12; y++; }
  while (mo < 1) { mo += 12; y--; }
  if (firstLast === 'first') d = 1;
  else if (firstLast === 'last') d = daysInMonth(y, mo);
  if (firstLast && !timeSet) { h = mi = sec = 0; }
  d += rel.d; h += rel.h; mi += rel.mi; sec += rel.s;
  if (weekday !== null) {
    const cur = new Date(utcMs(y, mo, d, 0, 0, 0)).getUTCDay();
    let diff = (weekday - cur + 7) % 7;
    if (weekdayDir === 1 && diff === 0) diff = 7;
    if (weekdayDir === -1) { diff = diff === 0 ? -7 : diff - 7; }
    d += diff;
    if (!timeSet) { h = mi = sec = 0; }
  }
  if (rel.wd) {
    let n = rel.wd; const step = n > 0 ? 1 : -1;
    while (n !== 0) { d += step; const wd = new Date(utcMs(y, mo, d, 0, 0, 0)).getUTCDay(); if (wd !== 0 && wd !== 6) n -= step; }
  }
  if (zoneOff !== null) return Math.floor(utcMs(y, mo, d, h, mi, sec) / 1000) - zoneOff;
  return localToTs(y, mo, d, h, mi, sec, zone || tz);
}
def('strtotime', (datetime, baseTimestamp = null) => strToTime(S(datetime), baseTimestamp === null ? nowTs() : I(baseTimestamp), rt.tz));
def('date_parse', (datetime) => {
  const ts = strToTime(S(datetime), nowTs(), rt.tz);
  const out = new PHPArray();
  if (ts === false) { out.set('error_count', 1); return out; }
  const t = tzInfo(ts, rt.tz);
  for (const [k, v] of [['year', t.y], ['month', t.mo], ['day', t.d], ['hour', t.h], ['minute', t.mi], ['second', t.s], ['fraction', mkf(0)], ['warning_count', 0], ['warnings', new PHPArray()], ['error_count', 0], ['errors', new PHPArray()], ['is_localtime', false]]) out.set(k, v);
  return out;
});
def('__tz_info', (ts, tz) => { const t = tzInfo(I(ts), S(tz)); return PHPArray.fromPairs([['offset', t.offset], ['abbr', t.abbr], ['dst', t.dst], ['y', t.y], ['m', t.mo], ['d', t.d], ['h', t.h], ['i', t.mi], ['s', t.s], ['dow', t.dow]]); });
def('__date_tz', (format, ts, tz, micro = 0) => phpDate(S(format), I(ts), S(tz), I(micro)));
def('__strtotime_tz', (str, base, tz) => strToTime(S(str), I(base), S(tz)));
def('__local_to_ts', (y, m, d, h, i, s, tz) => localToTs(I(y), I(m), I(d), I(h), I(i), I(s), S(tz)));
def('__valid_tz', (tz) => validTz(S(tz)));
