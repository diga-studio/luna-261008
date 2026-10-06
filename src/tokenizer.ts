import { ZoneError } from './types';

export enum TokenKind {
  Word,
  Quoted,
  Newline,
  EOF,
}

export interface Token {
  readonly kind: TokenKind;
  /** Raw bytes of the token after escape processing (empty for Newline/EOF). */
  readonly bytes: Uint8Array;
  /** Per-byte flag: 1 when the byte was produced by a `\` escape. */
  readonly escaped: Uint8Array;
  readonly line: number;
  /** True when whitespace separates this token from the previous token or line start. */
  readonly leadingBlank: boolean;
}

/**
 * Splits zone text into tokens. Handles `;` comments, `( )` line
 * continuations, quoted strings and `\` escapes. Parentheses do not nest.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let parenDepth = 0;
  let blankBefore = false;

  const pushNewline = (): void => {
    if (parenDepth === 0) {
      tokens.push({ kind: TokenKind.Newline, bytes: new Uint8Array(0), escaped: new Uint8Array(0), line, leadingBlank: false });
    }
  };

  const readEscape = (startLine: number): number => {
    // pos points at the character after the backslash.
    if (pos >= text.length) {
      throw new ZoneError('trailing backslash', startLine);
    }
    const ch = text[pos]!;
    if (ch === '\n' || ch === '\r') {
      throw new ZoneError('backslash before end of line', startLine);
    }
    if (ch >= '0' && ch <= '9') {
      const digits = text.slice(pos, pos + 3);
      if (digits.length !== 3 || !/^[0-9]{3}$/.test(digits)) {
        throw new ZoneError('escape with digit must have exactly three decimal digits', startLine);
      }
      const value = Number(digits);
      if (value > 255) {
        throw new ZoneError(`decimal escape \\${digits} exceeds 255`, startLine);
      }
      pos += 3;
      return value;
    }
    pos += 1;
    return ch.charCodeAt(0);
  };

  while (pos < text.length) {
    const ch = text[pos]!;
    if (ch === '\n') {
      pushNewline();
      line += 1;
      pos += 1;
      blankBefore = false;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      blankBefore = true;
      pos += 1;
      continue;
    }
    if (ch === ';') {
      while (pos < text.length && text[pos] !== '\n') {
        pos += 1;
      }
      continue;
    }
    if (ch === '(') {
      if (parenDepth > 0) {
        throw new ZoneError('nested parentheses are not allowed', line);
      }
      parenDepth = 1;
      pos += 1;
      blankBefore = true;
      continue;
    }
    if (ch === ')') {
      if (parenDepth === 0) {
        throw new ZoneError('unmatched closing parenthesis', line);
      }
      parenDepth = 0;
      pos += 1;
      blankBefore = true;
      continue;
    }
    if (ch.charCodeAt(0) > 0x7f) {
      throw new ZoneError('non-ASCII input; use \\DDD escapes for other bytes', line);
    }

    const startLine = line;
    const leadingBlank = blankBefore;
    blankBefore = false;

    if (ch === '"') {
      pos += 1;
      const buf: number[] = [];
      const esc: number[] = [];
      let closed = false;
      while (pos < text.length) {
        const c = text[pos]!;
        if (c === '"') {
          pos += 1;
          closed = true;
          break;
        }
        if (c === '\n') {
          break;
        }
        if (c.charCodeAt(0) > 0x7f) {
          throw new ZoneError('non-ASCII input; use \\DDD escapes for other bytes', startLine);
        }
        if (c === '\\') {
          pos += 1;
          buf.push(readEscape(startLine));
          esc.push(1);
        } else {
          buf.push(c.charCodeAt(0));
          esc.push(0);
          pos += 1;
        }
      }
      if (!closed) {
        throw new ZoneError('unterminated quoted string', startLine);
      }
      tokens.push({ kind: TokenKind.Quoted, bytes: Uint8Array.from(buf), escaped: Uint8Array.from(esc), line: startLine, leadingBlank });
      continue;
    }

    const buf: number[] = [];
    const esc: number[] = [];
    while (pos < text.length) {
      const c = text[pos]!;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ';' || c === '(' || c === ')' || c === '"') {
        break;
      }
      if (c.charCodeAt(0) > 0x7f) {
        throw new ZoneError('non-ASCII input; use \\DDD escapes for other bytes', startLine);
      }
      if (c === '\\') {
        pos += 1;
        buf.push(readEscape(startLine));
        esc.push(1);
      } else {
        buf.push(c.charCodeAt(0));
        esc.push(0);
        pos += 1;
      }
    }
    tokens.push({ kind: TokenKind.Word, bytes: Uint8Array.from(buf), escaped: Uint8Array.from(esc), line: startLine, leadingBlank });
  }

  if (parenDepth > 0) {
    throw new ZoneError('unclosed parenthesis', line);
  }
  tokens.push({ kind: TokenKind.EOF, bytes: new Uint8Array(0), escaped: new Uint8Array(0), line, leadingBlank: false });
  return tokens;
}
