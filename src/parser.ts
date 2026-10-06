import { normalizeNumber } from './decimal';
import type { JsonNode } from './types';

/** Inputs are specified to nest at most 128 levels; allow headroom, stay recursive-safe. */
const MAX_DEPTH = 256;

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parse(): JsonNode {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw new Error(`unexpected trailing content at offset ${this.pos}`);
    }
    return value;
  }

  private peek(): number {
    return this.pos < this.text.length ? this.text.charCodeAt(this.pos) : -1;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        this.pos += 1;
      } else {
        return;
      }
    }
  }

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_DEPTH) {
      throw new Error(`nesting deeper than ${MAX_DEPTH} levels`);
    }
    const c = this.peek();
    if (c === 123) return this.parseObject(depth); // {
    if (c === 91) return this.parseArray(depth); // [
    if (c === 34) return { kind: 'string', value: this.parseString() }; // "
    if (c === 116) return this.parseLiteral('true', { kind: 'boolean', value: true });
    if (c === 102) return this.parseLiteral('false', { kind: 'boolean', value: false });
    if (c === 110) return this.parseLiteral('null', { kind: 'null' });
    if (c === 45 || (c >= 48 && c <= 57)) return this.parseNumber();
    throw new Error(`unexpected character at offset ${this.pos}`);
  }

  private parseLiteral(word: string, node: JsonNode): JsonNode {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return node;
    }
    throw new Error(`invalid literal at offset ${this.pos}`);
  }

  private parseObject(depth: number): JsonNode {
    this.pos += 1; // {
    const entries = new Map<string, JsonNode>();
    this.skipWhitespace();
    if (this.peek() === 125) {
      this.pos += 1;
      return { kind: 'object', entries };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== 34) throw new Error(`expected object key at offset ${this.pos}`);
      const key = this.parseString();
      this.skipWhitespace();
      if (this.peek() !== 58) throw new Error(`expected ':' at offset ${this.pos}`);
      this.pos += 1;
      this.skipWhitespace();
      const value = this.parseValue(depth + 1);
      entries.set(key, value);
      this.skipWhitespace();
      const c = this.peek();
      if (c === 44) {
        this.pos += 1;
        continue;
      }
      if (c === 125) {
        this.pos += 1;
        return { kind: 'object', entries };
      }
      throw new Error(`expected ',' or '}' at offset ${this.pos}`);
    }
  }

  private parseArray(depth: number): JsonNode {
    this.pos += 1; // [
    const items: JsonNode[] = [];
    this.skipWhitespace();
    if (this.peek() === 93) {
      this.pos += 1;
      return { kind: 'array', items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const c = this.peek();
      if (c === 44) {
        this.pos += 1;
        continue;
      }
      if (c === 93) {
        this.pos += 1;
        return { kind: 'array', items };
      }
      throw new Error(`expected ',' or ']' at offset ${this.pos}`);
    }
  }

  private parseString(): string {
    this.pos += 1; // opening quote
    const text = this.text;
    let start = this.pos;
    const chunks: string[] = [];
    for (;;) {
      if (this.pos >= text.length) throw new Error('unterminated string');
      const c = text.charCodeAt(this.pos);
      if (c === 34) {
        chunks.push(text.slice(start, this.pos));
        this.pos += 1;
        return chunks.join('');
      }
      if (c === 92) {
        chunks.push(text.slice(start, this.pos));
        chunks.push(this.parseEscape());
        start = this.pos;
        continue;
      }
      this.pos += 1;
    }
  }

  private parseEscape(): string {
    this.pos += 1; // backslash
    const c = this.text.charCodeAt(this.pos);
    this.pos += 1;
    switch (c) {
      case 34: return '"';
      case 92: return '\\';
      case 47: return '/';
      case 98: return '\b';
      case 102: return '\f';
      case 110: return '\n';
      case 114: return '\r';
      case 116: return '\t';
      case 117: {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad \\u escape at offset ${this.pos}`);
        this.pos += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        throw new Error(`bad escape at offset ${this.pos - 1}`);
    }
  }

  private parseNumber(): JsonNode {
    const start = this.pos;
    if (this.peek() === 45) this.pos += 1;
    this.skipDigits();
    if (this.peek() === 46) {
      this.pos += 1;
      this.skipDigits();
    }
    const e = this.peek();
    if (e === 101 || e === 69) {
      this.pos += 1;
      const sign = this.peek();
      if (sign === 43 || sign === 45) this.pos += 1;
      this.skipDigits();
    }
    const raw = this.text.slice(start, this.pos);
    return { kind: 'number', raw, num: normalizeNumber(raw) };
  }

  private skipDigits(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c < 48 || c > 57) return;
      this.pos += 1;
    }
  }
}

/** Parse UTF-8 JSON text into a JsonNode tree, preserving raw number literals. */
export function parseJson(text: string): JsonNode {
  return new Parser(text).parse();
}
