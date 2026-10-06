import type { ConfigNode } from './types.js';

const NULL_NODE: ConfigNode = { type: 'null' };

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parse(): ConfigNode {
    this.skipWhitespace();
    const node = this.parseValue();
    this.skipWhitespace();
    return node;
  }

  private skipWhitespace(): void {
    const text = this.text;
    while (this.pos < text.length) {
      const c = text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  private parseValue(): ConfigNode {
    const c = this.text.charCodeAt(this.pos);
    if (c === 0x7b /* { */) return this.parseObject();
    if (c === 0x5b /* [ */) return this.parseArray();
    if (c === 0x22 /* " */) return { type: 'string', value: this.parseString() };
    if (c === 0x74 /* t */) {
      this.pos += 4; // true
      return { type: 'boolean', value: true };
    }
    if (c === 0x66 /* f */) {
      this.pos += 5; // false
      return { type: 'boolean', value: false };
    }
    if (c === 0x6e /* n */) {
      this.pos += 4; // null
      return NULL_NODE;
    }
    return this.parseNumber();
  }

  private parseObject(): ConfigNode {
    this.pos++; // {
    const entries: [string, ConfigNode][] = [];
    this.skipWhitespace();
    if (this.text.charCodeAt(this.pos) === 0x7d /* } */) {
      this.pos++;
      return { type: 'object', entries };
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      this.skipWhitespace();
      this.pos++; // :
      this.skipWhitespace();
      const value = this.parseValue();
      entries.push([key, value]);
      this.skipWhitespace();
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x2c /* , */) {
        this.pos++;
        continue;
      }
      this.pos++; // }
      return { type: 'object', entries };
    }
  }

  private parseArray(): ConfigNode {
    this.pos++; // [
    const items: ConfigNode[] = [];
    this.skipWhitespace();
    if (this.text.charCodeAt(this.pos) === 0x5d /* ] */) {
      this.pos++;
      return { type: 'array', items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x2c /* , */) {
        this.pos++;
        continue;
      }
      this.pos++; // ]
      return { type: 'array', items };
    }
  }

  private parseString(): string {
    const text = this.text;
    this.pos++; // opening quote
    let start = this.pos;
    let result = '';
    for (;;) {
      const c = text.charCodeAt(this.pos);
      if (c === 0x22 /* " */) {
        result += text.slice(start, this.pos);
        this.pos++;
        return result;
      }
      if (c === 0x5c /* \ */) {
        result += text.slice(start, this.pos);
        this.pos++;
        const esc = text.charCodeAt(this.pos);
        this.pos++;
        switch (esc) {
          case 0x22: result += '"'; break;
          case 0x5c: result += '\\'; break;
          case 0x2f: result += '/'; break;
          case 0x62: result += '\b'; break;
          case 0x66: result += '\f'; break;
          case 0x6e: result += '\n'; break;
          case 0x72: result += '\r'; break;
          case 0x74: result += '\t'; break;
          case 0x75: {
            const code = parseInt(text.slice(this.pos, this.pos + 4), 16);
            result += String.fromCharCode(code);
            this.pos += 4;
            break;
          }
        }
        start = this.pos;
        continue;
      }
      this.pos++;
    }
  }

  private parseNumber(): ConfigNode {
    const text = this.text;
    const start = this.pos;
    if (text.charCodeAt(this.pos) === 0x2d /* - */) this.pos++;
    while (this.pos < text.length) {
      const c = text.charCodeAt(this.pos);
      if (c >= 0x30 && c <= 0x39) this.pos++;
      else break;
    }
    if (text.charCodeAt(this.pos) === 0x2e /* . */) {
      this.pos++;
      while (this.pos < text.length) {
        const c = text.charCodeAt(this.pos);
        if (c >= 0x30 && c <= 0x39) this.pos++;
        else break;
      }
    }
    const e = text.charCodeAt(this.pos);
    if (e === 0x65 || e === 0x45 /* e E */) {
      this.pos++;
      const sign = text.charCodeAt(this.pos);
      if (sign === 0x2b || sign === 0x2d /* + - */) this.pos++;
      while (this.pos < text.length) {
        const c = text.charCodeAt(this.pos);
        if (c >= 0x30 && c <= 0x39) this.pos++;
        else break;
      }
    }
    return { type: 'number', raw: text.slice(start, this.pos) };
  }
}

/**
 * Parses UTF-8 JSON text into a ConfigNode tree, preserving raw number
 * literals and decoding string/key escapes. Input is assumed syntactically
 * valid with no duplicate decoded keys per object.
 */
export function parseJsonText(text: string): ConfigNode {
  return new Parser(text).parse();
}
