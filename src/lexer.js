// Lexer: PHP source -> tokens (inline HTML, heredoc/nowdoc, interpolation, casts).

import { I64MAX, normBig, ParseErr } from './values.js';
import { rt } from './runtime/state.js';

const OPS3 = ['<<=', '>>=', '**=', '...', '<=>', '===', '!==', '??=', '?->'];
const OPS2 = ['++', '--', '->', '=>', '::', '==', '!=', '<>', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const OPS1 = '+-*/%=<>!.()[]{},;?:&|^~@$`\\';
const CAST_RE = /^\(\s*(int|integer|bool|boolean|float|double|real|string|binary|array|object|unset)\s*\)/i;
const isIdStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isIdChar = (c) => isIdStart(c) || (c >= 48 && c <= 57);

function encodeCodepoint(c) {
  if (c < 0x80) return String.fromCharCode(c);
  if (c < 0x800) return String.fromCharCode(0xC0 | (c >> 6), 0x80 | (c & 63));
  if (c < 0x10000) return String.fromCharCode(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  return String.fromCharCode(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
}
export function lex(src, file) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const shortTags = typeof rt !== 'undefined' && rt.ini && /^(1|on|true)$/i.test(String(rt.ini.get('short_open_tag') || ''));
  const err = (m) => { throw new ParseErr(m, line); };
  // The last /** doc comment */ stays pending (as in PHP) until a declaration takes it or a "}"
  // ends it; tokens lexed meanwhile share one slot object, see Parser.takeDoc
  let doc = null;
  // brackets are matched here, as PHP's lexer does: the first mismatch becomes an error token,
  // reported when the parser gets to it (so earlier syntax errors win)
  const brackets = [];
  let bracketError = false;
  const bracketErr = (msg) => { bracketError = true; toks.push({ t: 'error', v: msg, l: line }); };
  const unclosed = (b) => `Unclosed '${b.c}'${b.l !== line ? ` on line ${b.l}` : ''}`;
  const push = (t, v, extra) => {
    if (t === 'op' && !bracketError) {
      if (v === '(' || v === '[' || v === '{' || v === '#[') brackets.push({ c: v === '#[' ? '[' : v, l: line });
      else if (v === ')' || v === ']' || v === '}') {
        const b = brackets.pop();
        if (!b) bracketErr(`Unmatched '${v}'`);
        else if ({ '(': ')', '[': ']', '{': '}' }[b.c] !== v) bracketErr(`${unclosed(b)} does not match '${v}'`);
      }
    }
    const tk = { t, v, l: line };
    if (extra) Object.assign(tk, extra);
    if (doc !== null) { tk.doc = doc; if (t === 'op' && v === '}') doc = null; }
    toks.push(tk);
    return tk;
  };
  const countNl = (s) => { let c = 0; for (let j = 0; j < s.length; j++) if (s.charCodeAt(j) === 10) c++; return c; };

  function htmlMode() {
    let start = i;
    while (i < n) {
      const p = src.indexOf('<?', i);
      if (p < 0) { i = n; break; }
      if (src.substr(p, 5).toLowerCase() === '<?php' && (p + 5 >= n || /\s/.test(src[p + 5]))) {
        if (p > start) { const h = src.slice(start, p); push('html', h); line += countNl(h); }
        i = p + 5; if (src[i] === '\n') { line++; i++; } else if (src[i] === '\r' && src[i + 1] === '\n') { line++; i += 2; } else if (i < n) i++;
        return true;
      }
      if (src[p + 2] === '=') {
        if (p > start) { const h = src.slice(start, p); push('html', h); line += countNl(h); }
        i = p + 3; push('id', 'echo');
        return true;
      }
      if (shortTags && (p + 2 >= n || /\s/.test(src[p + 2]))) {
        if (p > start) { const h = src.slice(start, p); push('html', h); line += countNl(h); }
        i = p + 2;
        return true;
      }
      i = p + 2;
    }
    if (i > start) { const h = src.slice(start, i); push('html', h); line += countNl(h); }
    return false;
  }
  if (src.startsWith('#!')) { const e = src.indexOf('\n'); i = e < 0 ? n : e + 1; line = 2; }
  const end = () => { if (!bracketError && brackets.length) bracketErr(unclosed(brackets[brackets.length - 1])); push('eof', null); return toks; };
  if (!htmlMode()) return end();

  while (i < n) {
    const c = src.charCodeAt(i);
    // whitespace
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12) { i++; continue; }
    if (c === 10) { line++; i++; continue; }
    const ch = src[i];
    // comments
    if (ch === '#' && src[i + 1] === '[') { push('op', '#['); i += 2; continue; } // attribute group
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) {
      while (i < n && src[i] !== '\n') {
        if (src[i] === '?' && src[i + 1] === '>') break;
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      if (src[i + 2] === '*' && end - i > 4 && /\s/.test(src[i + 3])) doc = { text: src.slice(i, end), used: false };
      line += countNl(src.slice(i, end));
      i = end; continue;
    }
    // close tag
    if (ch === '?' && src[i + 1] === '>') {
      push('op', ';', { close: true });
      i += 2;
      // one newline after ?> belongs to the tag: \n, \r\n or \r
      if (src[i] === '\n') { i++; line++; } else if (src[i] === '\r') { i += src[i + 1] === '\n' ? 2 : 1; line++; }
      if (!htmlMode()) break;
      continue;
    }
    // variables
    if (ch === '$' && i + 1 < n && isIdStart(src.charCodeAt(i + 1))) {
      let j = i + 1; while (j < n && isIdChar(src.charCodeAt(j))) j++;
      push('var', src.slice(i + 1, j)); i = j; continue;
    }
    // identifiers / names
    if (isIdStart(c) || (ch === '\\' && i + 1 < n && isIdStart(src.charCodeAt(i + 1)))) {
      let j = i; if (ch === '\\') j++;
      for (;;) {
        while (j < n && isIdChar(src.charCodeAt(j))) j++;
        if (src[j] === '\\' && j + 1 < n && isIdStart(src.charCodeAt(j + 1))) { j++; continue; }
        break;
      }
      const word = src.slice(i, j);
      i = j;
      const lw = word.toLowerCase();
      // heredoc is handled elsewhere; special keyword combos
      if (lw === 'yield') {
        const m = /^\s+from\b/i.exec(src.slice(i, i + 40));
        if (m) { line += countNl(m[0]); i += m[0].length; push('id', 'yield from'); continue; }
      }
      push('id', word);
      continue;
    }
    // numbers
    if ((c >= 48 && c <= 57) || (ch === '.' && i + 1 < n && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      let m;
      const stick = (re) => { re.lastIndex = i; return re.exec(src); };
      if ((m = stick(/0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*/y))) { i += m[0].length; pushInt(m[0].slice(2).replace(/_/g, ''), 16, m[0]); continue; }
      if ((m = stick(/0[bB][01]+(?:_[01]+)*/y))) { i += m[0].length; pushInt(m[0].slice(2).replace(/_/g, ''), 2, m[0]); continue; }
      if ((m = stick(/0[oO][0-7]+(?:_[0-7]+)*/y))) { i += m[0].length; pushInt(m[0].slice(2).replace(/_/g, ''), 8, m[0]); continue; }
      m = stick(/(\d+(?:_\d+)*)?(\.\d+(?:_\d+)*|\.)?([eE][+-]?\d+(?:_\d+)*)?/y);
      let txt = m[0];
      if (txt.endsWith('.') && src[i + txt.length] === '.') txt = txt.slice(0, -1); // 1..2
      i += txt.length;
      const clean = txt.replace(/_/g, '');
      if (m[2] === undefined && m[3] === undefined || (txt === m[1])) {
        if (clean.length > 1 && clean[0] === '0') {
          if (!/^[0-7]+$/.test(clean)) err('Invalid numeric literal');
          pushInt(clean.slice(1), 8, txt);
        } else pushInt(clean, 10, txt);
      } else push('float', Number(clean), { raw: txt });
      continue;
    }
    // strings
    if (ch === "'") {
      let j = i + 1, s = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && (src[j + 1] === "'" || src[j + 1] === '\\')) { s += src[j + 1]; j += 2; continue; }
        s += src[j]; j++;
      }
      if (j >= n) err('syntax error, unexpected end of file');
      push('str', s, { sq: true }); line += countNl(s); i = j + 1; continue;
    }
    if (ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') { j += 2; continue; }
        // {$...} and ${...} hold code, which may contain quotes
        if ((src[j] === '{' && src[j + 1] === '$') || (src[j] === '$' && src[j + 1] === '{')) { j = matchBrace(src, src[j] === '{' ? j : j + 1) + 1; continue; }
        j++;
      }
      if (j >= n) err('syntax error, unexpected end of file');
      const raw = src.slice(i + 1, j);
      const startLine = line;
      const parts = interp(raw, ch === '"' ? '"' : '`', startLine);
      line += countNl(raw);
      i = j + 1;
      if (ch === '`') push('shell', parts, { l: startLine });
      else if (parts.length === 1 && typeof parts[0] === 'string') push('str', parts[0], { l: startLine });
      else if (parts.length === 0) push('str', '', { l: startLine });
      else push('tpl', parts, { l: startLine });
      continue;
    }
    // heredoc / nowdoc
    if (ch === '<' && src.startsWith('<<<', i)) {
      const m = /^<<<[ \t]*(["']?)([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)\1\r?\n/.exec(src.slice(i, i + 300));
      if (m) {
        const id = m[2], nowdoc = m[1] === "'";
        const bodyStart = i + m[0].length;
        const startLine = line;
        line++;
        // find closing marker: a line consisting of optional whitespace + id, followed by non-id char
        let found = -1, indent = '';
        const inCode = new Set(); // lines of the body that start inside an interpolated expression
        const marker = new RegExp('([ \\t]*)' + id.replace(/[^\w]/g, '\\$&') + '(?![A-Za-z0-9_\\x80-\\xff])', 'y');
        // (in a heredoc, the marker isn't looked for inside {$...} and ${...})
        for (let k = bodyStart, lineNo = 0, atStart = true; k < src.length;) {
          if (atStart) { marker.lastIndex = k; const mm = marker.exec(src); if (mm) { found = k; indent = mm[1]; break; } atStart = false; }
          const c = src[k];
          if (c === '\n') { lineNo++; atStart = true; k++; }
          else if (nowdoc) k++;
          else if (c === '\\') { if (src[k + 1] === '\n') { lineNo++; atStart = true; } k += 2; }
          else if ((c === '{' && src[k + 1] === '$') || (c === '$' && src[k + 1] === '{')) {
            const end = matchBrace(src, c === '{' ? k : k + 1);
            for (let q = k; q < end; q++) if (src[q] === '\n') inCode.add(++lineNo);
            k = end + 1;
          } else k++;
        }
        if (found < 0) err('syntax error, unexpected end of file');
        let body = found > bodyStart ? src.slice(bodyStart, found - 1) : '';
        if (body.endsWith('\r')) body = body.slice(0, -1);
        if (found === bodyStart) body = '';
        line += countNl(src.slice(bodyStart, found));
        i = found + indent.length + id.length;
        if (indent.length) {
          // the closing marker's indentation is removed from every line (it may not mix tabs and
          // spaces, and neither may the lines); errors are reported at the line they're found on
          if (indent.includes(' ') && indent.includes('\t')) throw new ParseErr('Invalid indentation - tabs and spaces cannot be mixed', startLine + 1);
          const ch = indent[0];
          body = body.split('\n').map((ln, idx) => {
            if (inCode.has(idx)) return ln;
            let k = 0;
            while (k < indent.length && (ln[k] === ' ' || ln[k] === '\t')) {
              if (ln[k] !== ch) throw new ParseErr('Invalid indentation - tabs and spaces cannot be mixed', startLine + 1 + idx);
              k++;
            }
            if (k < indent.length && k < ln.length && ln.slice(k) !== '\r') throw new ParseErr('Invalid body indentation level (expecting an indentation level of at least ' + indent.length + ')', startLine + 1 + idx);
            return ln.slice(k);
          }).join('\n');
        }
        const heredoc = '<<<' + (m[1] ? m[1] : '') + id; // as PHP shows it in syntax errors
        if (nowdoc) push('str', body, { l: startLine, heredoc });
        else {
          const parts = interp(body, 'h', startLine + 1);
          if (parts.length === 0) push('str', '', { l: startLine, heredoc });
          else if (parts.length === 1 && typeof parts[0] === 'string') push('str', parts[0], { l: startLine, heredoc });
          else push('tpl', parts, { l: startLine, heredoc });
        }
        continue;
      }
    }
    // casts
    if (ch === '(') {
      const m = CAST_RE.exec(src.slice(i, i + 30));
      if (m) {
        let t = m[1].toLowerCase();
        if (t === 'real') err('The (real) cast has been removed, use (float) instead');
        t = { integer: 'int', boolean: 'bool', double: 'float', real: 'float', binary: 'string' }[t] || t;
        push('cast', t); i += m[0].length; continue;
      }
    }
    // operators
    const s3 = src.substr(i, 3);
    if (OPS3.includes(s3)) { push('op', s3); i += 3; continue; }
    const s2 = src.substr(i, 2);
    if (OPS2.includes(s2)) { push('op', s2); i += 2; continue; }
    if (OPS1.includes(ch)) { push('op', ch); i++; continue; }
    err(`syntax error, unexpected character 0x${c.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  return end();

  function pushInt(digits, base, raw) { // raw: the source text, for syntax errors
    if (digits === '') digits = '0';
    let b;
    if (base === 10) b = BigInt(digits);
    else b = BigInt((base === 16 ? '0x' : base === 8 ? '0o' : '0b') + digits);
    if (b > I64MAX) push('float', Number(b), { raw });
    else push('int', normBig(b), { raw });
  }

  // process escapes and interpolation; returns array of string | {code, line}
  function interp(raw, mode, startLine) {
    const parts = [];
    let cur = '', j = 0, ln = startLine;
    // the line PHP is compiling at when it reaches a ${...}: the string's, then that of the last
    // embedded expression
    let compLine = startLine;
    const m = raw.length;
    const flush = () => { if (cur) { parts.push(cur); cur = ''; } };
    while (j < m) {
      const d = raw[j];
      if (d === '\n') ln++;
      if (d === '\\' && j + 1 < m) {
        const e = raw[j + 1];
        switch (e) {
          case 'n': cur += '\n'; j += 2; continue;
          case 't': cur += '\t'; j += 2; continue;
          case 'r': cur += '\r'; j += 2; continue;
          case 'v': cur += '\v'; j += 2; continue;
          case 'e': cur += '\x1b'; j += 2; continue;
          case 'f': cur += '\f'; j += 2; continue;
          case '\\': cur += '\\'; j += 2; continue;
          case '$': cur += '$'; j += 2; continue;
          case '{': cur += '\\{'; j += 2; continue;
          case '"': if (mode === '"') { cur += '"'; j += 2; continue; } break;
          case '`': if (mode === '`') { cur += '`'; j += 2; continue; } break;
          case 'u': {
            if (raw[j + 2] !== '{') break;
            const mm = /^\\u\{([0-9a-fA-F]+)\}/.exec(raw.slice(j, j + 40));
            if (!mm) throw new ParseErr('Invalid UTF-8 codepoint escape sequence', ln);
            const cpv = parseInt(mm[1], 16);
            if (cpv > 0x10FFFF) throw new ParseErr('Invalid UTF-8 codepoint escape sequence: Codepoint too large', ln);
            cur += encodeCodepoint(cpv); j += mm[0].length; continue;
          }
          case 'x': {
            const mm = /^\\x([0-9a-fA-F]{1,2})/.exec(raw.slice(j, j + 4));
            if (mm) { cur += String.fromCharCode(parseInt(mm[1], 16)); j += mm[0].length; continue; }
            break;
          }
          default:
            if (e >= '0' && e <= '7') {
              const mm = /^\\([0-7]{1,3})/.exec(raw.slice(j, j + 4));
              cur += String.fromCharCode(parseInt(mm[1], 8) & 255); j += mm[0].length; continue;
            }
        }
        cur += d; j++; continue;
      }
      if (d === '$' && j + 1 < m && isIdStart(raw.charCodeAt(j + 1))) {
        let k = j + 1; while (k < m && isIdChar(raw.charCodeAt(k))) k++;
        let code = '$' + raw.slice(j + 1, k);
        if (raw[k] === '[') {
          const mm = /^\[(?:(\$[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)|(-?\d+)|([A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*))\]/.exec(raw.slice(k, k + 200));
          if (mm) {
            if (mm[1]) code += '[' + mm[1] + ']';
            else if (mm[2] !== undefined) code += /^-?(0|[1-9]\d*)$/.test(mm[2]) ? '[' + mm[2] + ']' : "['" + mm[2] + "']";
            else code += "['" + mm[3] + "']";
            k += mm[0].length;
          } else {
            // what PHP's lexer accepts after "$var[" in a string: a name, a number, a variable, then "]"
            const key = /^\[(\$[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*|-?\d+|[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)/.exec(raw.slice(k, k + 200));
            const expect = '"-" or identifier or variable or number';
            if (key) {
              const after = raw[k + key[0].length];
              err(`syntax error, unexpected ${after === undefined ? (mode === '"' ? 'double-quote mark' : 'string content ""') : after === '-' || after === '[' ? `token "${after}"` : 'string content ""'}, expecting "]"`);
            }
            if (raw[k + 1] === ']') err(`syntax error, unexpected token "]", expecting ${expect}`);
            if (raw[k + 1] === '-') { const id = /^[A-Za-z_]\w*/.exec(raw.slice(k + 2)); err(id ? `syntax error, unexpected identifier "${id[0]}", expecting number` : 'syntax error, unexpected string content "", expecting number'); }
            err(`syntax error, unexpected string content "", expecting ${expect}`);
          }
        } else if ((raw[k] === '-' && raw[k + 1] === '>' && isIdStart(raw.charCodeAt(k + 2))) || (raw[k] === '?' && raw[k + 1] === '-' && raw[k + 2] === '>' && isIdStart(raw.charCodeAt(k + 3)))) {
          const opLen = raw[k] === '?' ? 3 : 2;
          let q = k + opLen; while (q < m && isIdChar(raw.charCodeAt(q))) q++;
          code += raw.slice(k, q); k = q;
        }
        flush(); parts.push({ code, line: ln }); compLine = ln; j = k; continue;
      }
      if (d === '{' && raw[j + 1] === '$') {
        const end = matchBrace(raw, j);
        flush(); parts.push({ code: raw.slice(j + 1, end), line: ln }); compLine = ln;
        ln += countNl(raw.slice(j, end)); j = end + 1; continue;
      }
      if (d === '$' && raw[j + 1] === '{') {
        const end = matchBrace(raw, j + 1);
        const inner = raw.slice(j + 2, end);
        let code;
        if (/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*(\[|$)/.test(inner)) {
          code = '$' + inner;
          deprecation('Using ${var} in strings is deprecated, use {$var} instead', compLine);
        } else {
          code = '${' + inner + '}';
          deprecation('Using ${expr} (variable variables) in strings is deprecated, use {${expr}} instead', compLine);
        }
        flush(); parts.push({ code, line: ln }); compLine = ln;
        ln += countNl(raw.slice(j, end)); j = end + 1; continue;
      }
      cur += d; j++;
    }
    flush();
    return parts;
  }
  // deprecations PHP raises while compiling (checkProgram() reports them)
  function deprecation(msg, l) { (toks.compileDeprecations || (toks.compileDeprecations = [])).push({ msg, l, deprecated: true }); }
  function matchBrace(s, start) {
    let depth = 0;
    for (let k = start; k < s.length; k++) {
      const d = s[k];
      if (d === '{') depth++;
      else if (d === '}') { depth--; if (depth === 0) return k; }
      else if (d === "'" || d === '"') { const q = d; k++; while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++; } }
    }
    throw new ParseErr('syntax error, unexpected end of file', line);
  }
}
