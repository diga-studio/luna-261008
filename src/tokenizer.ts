import { ZoneParseError } from './types';

export interface Token {
  /** Decoded bytes of the token (escapes resolved, quotes removed). */
  bytes: Uint8Array;
  /** Raw source text of the token (escapes intact, quotes removed). */
  raw: string;
  quoted: boolean;
  line: number; // 1-based line where the token starts
}

export interface LogicalLine {
  tokens: Token[];
  line: number; // line of first token
  startsWithWhitespace: boolean;
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** Split zone text into logical lines, resolving comments, quotes, parens. */
export function tokenize(text: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  let tokens: Token[] = [];
  let logicalLine = 1;
  let logicalLineWs = false;
  let inParens = false;
  let parenLine = 0;
  let line = 1;
  let sawWsOnLine = false; // whitespace seen before any token on this physical line

  // token under construction
  let tokRaw = '';
  let tokBytes: number[] = [];
  let tokQuoted = false;
  let tokLine = 0;
  let building = false;

  const startToken = (quoted: boolean) => {
    if (tokens.length === 0 && !building) {
      logicalLine = line;
      logicalLineWs = sawWsOnLine;
    }
    building = true;
    tokQuoted = quoted;
    tokRaw = '';
    tokBytes = [];
    tokLine = line;
  };

  const endToken = () => {
    if (!building) return;
    tokens.push({
      bytes: Uint8Array.from(tokBytes),
      raw: tokRaw,
      quoted: tokQuoted,
      line: tokLine,
    });
    building = false;
  };

  const flushLine = () => {
    endToken();
    if (tokens.length > 0) {
      out.push({ tokens, line: logicalLine, startsWithWhitespace: logicalLineWs });
      tokens = [];
    }
  };

  const readEscape = (i: number): { byte: number; next: number } => {
    const next = text[i + 1];
    if (next === undefined || next === '\n') {
      throw new ZoneParseError('trailing backslash', line);
    }
    if (isDigit(next)) {
      const digits = text.substr(i + 1, 3);
      if (!/^[0-9]{3}$/.test(digits)) {
        throw new ZoneParseError(`bad numeric escape \\${digits}`, line);
      }
      const value = parseInt(digits, 10);
      if (value > 255) {
        throw new ZoneParseError(`escape \\${digits} exceeds 255`, line);
      }
      return { byte: value, next: i + 4 };
    }
    const code = next.charCodeAt(0);
    if (code > 0x7e) {
      throw new ZoneParseError('non-ASCII byte in input; use \\DDD escapes', line);
    }
    return { byte: code, next: i + 2 };
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const code = c.charCodeAt(0);

    if (building && tokQuoted) {
      // inside a quoted string
      if (c === '\\') {
        const esc = readEscape(i);
        tokRaw += text.substring(i, esc.next);
        tokBytes.push(esc.byte);
        i = esc.next;
        continue;
      }
      if (c === '"') {
        endToken();
        i += 1;
        continue;
      }
      if (c === '\n') {
        throw new ZoneParseError('unterminated quoted string', tokLine);
      }
      if (code > 0x7e || (code < 0x20 && c !== '\t')) {
        throw new ZoneParseError('non-ASCII or control byte in input; use \\DDD escapes', line);
      }
      tokRaw += c;
      tokBytes.push(code);
      i += 1;
      continue;
    }

    if (c === '\n') {
      sawWsOnLine = false;
      line += 1;
      if (!inParens) flushLine();
      else endToken();
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endToken();
      if (tokens.length === 0 && !building) sawWsOnLine = true;
      i += 1;
      continue;
    }
    if (c === ';') {
      endToken();
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '(') {
      endToken();
      if (inParens) throw new ZoneParseError('nested parentheses', line);
      inParens = true;
      parenLine = line;
      i += 1;
      continue;
    }
    if (c === ')') {
      endToken();
      if (!inParens) throw new ZoneParseError('unmatched )', line);
      inParens = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (building) throw new ZoneParseError('quote inside token', line);
      startToken(true);
      i += 1;
      continue;
    }
    if (c === '\\') {
      if (!building) startToken(false);
      const esc = readEscape(i);
      tokRaw += text.substring(i, esc.next);
      tokBytes.push(esc.byte);
      i = esc.next;
      continue;
    }
    if (code > 0x7e || code < 0x20) {
      throw new ZoneParseError('non-ASCII or control byte in input; use \\DDD escapes', line);
    }
    if (!building) startToken(false);
    tokRaw += c;
    tokBytes.push(code);
    i += 1;
  }

  if (building && tokQuoted) {
    throw new ZoneParseError('unterminated quoted string', tokLine);
  }
  if (inParens) {
    throw new ZoneParseError('unclosed parenthesis', parenLine);
  }
  flushLine();
  return out;
}
