import { FileImportError } from "./errors.js";

const MAX_RECORD_BYTES = 64 * 1024;

const QUOTE = 0x22;
const COMMA = 0x2c;
const CR = 0x0d;
const LF = 0x0a;

const enum State {
  FieldStart,
  Plain,
  Quoted,
  QuoteInQuoted,
  Cr,
}

interface FieldSpan {
  start: number;
  end: number;
  quoted: boolean;
}

/**
 * Streaming RFC 4180 CSV parser (also accepts LF record separators).
 * Parses at the byte level, so chunks may split anywhere, including
 * inside multi-byte UTF-8 characters, CRLF pairs and escaped quotes.
 * Fields are decoded as strict UTF-8 when a record completes.
 */
export class CsvParser {
  private buf = new Uint8Array(1024);
  private len = 0;
  private state: State = State.FieldStart;
  private fields: FieldSpan[] = [];
  private fieldStart = 0;
  private closeQuotePos = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Uint8Array): string[][] {
    const records: string[][] = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      switch (this.state) {
        case State.FieldStart:
          if (b === QUOTE) {
            this.append(b);
            this.state = State.Quoted;
          } else if (b === COMMA) {
            this.finishField(false);
          } else if (b === CR) {
            this.finishField(false);
            records.push(this.finishRecord());
            this.state = State.Cr;
          } else if (b === LF) {
            this.finishField(false);
            records.push(this.finishRecord());
          } else {
            this.append(b);
            this.state = State.Plain;
          }
          break;
        case State.Plain:
          if (b === COMMA) {
            this.finishField(false);
            this.state = State.FieldStart;
          } else if (b === CR) {
            this.finishField(false);
            records.push(this.finishRecord());
            this.state = State.Cr;
          } else if (b === LF) {
            this.finishField(false);
            records.push(this.finishRecord());
            this.state = State.FieldStart;
          } else if (b === QUOTE) {
            throw new FileImportError("CSV_SYNTAX", "quote inside unquoted field");
          } else {
            this.append(b);
          }
          break;
        case State.Quoted:
          this.append(b);
          if (b === QUOTE) {
            this.closeQuotePos = this.len - 1;
            this.state = State.QuoteInQuoted;
          }
          break;
        case State.QuoteInQuoted:
          if (b === QUOTE) {
            this.append(b);
            this.state = State.Quoted;
          } else if (b === COMMA) {
            this.finishField(true);
            this.state = State.FieldStart;
          } else if (b === CR) {
            this.finishField(true);
            records.push(this.finishRecord());
            this.state = State.Cr;
          } else if (b === LF) {
            this.finishField(true);
            records.push(this.finishRecord());
            this.state = State.FieldStart;
          } else {
            throw new FileImportError("CSV_SYNTAX", "unexpected byte after closing quote");
          }
          break;
        case State.Cr:
          if (b !== LF) {
            throw new FileImportError("CSV_SYNTAX", "CR not followed by LF");
          }
          this.state = State.FieldStart;
          break;
      }
    }
    return records;
  }

  end(): string[][] {
    if (this.state === State.Quoted) {
      throw new FileImportError("CSV_SYNTAX", "unterminated quoted field");
    }
    if (this.state === State.Cr) {
      this.state = State.FieldStart;
      return [];
    }
    const pending = this.len > 0 || this.fields.length > 0 || this.state !== State.FieldStart;
    if (!pending) return [];
    if (this.state === State.QuoteInQuoted) {
      this.finishField(true);
    } else {
      this.finishField(false);
    }
    const record = this.finishRecord();
    this.state = State.FieldStart;
    return [record];
  }

  private append(b: number): void {
    if (this.len >= MAX_RECORD_BYTES) {
      throw new FileImportError("RECORD_TOO_LARGE", "logical record exceeds 64 KiB");
    }
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf[this.len++] = b;
  }

  private finishField(quoted: boolean): void {
    if (quoted) {
      this.fields.push({ start: this.fieldStart + 1, end: this.closeQuotePos, quoted: true });
    } else {
      this.fields.push({ start: this.fieldStart, end: this.len, quoted: false });
    }
    this.fieldStart = this.len;
  }

  private finishRecord(): string[] {
    const record = this.fields.map((f) => this.decodeField(f));
    this.fields = [];
    this.len = 0;
    this.fieldStart = 0;
    return record;
  }

  private decodeField(span: FieldSpan): string {
    let bytes: Uint8Array = this.buf.subarray(span.start, span.end);
    if (span.quoted) {
      bytes = unescapeQuotes(bytes);
    }
    try {
      return this.decoder.decode(bytes);
    } catch {
      throw new FileImportError("INVALID_UTF8", "field is not valid UTF-8");
    }
  }
}

function unescapeQuotes(bytes: Uint8Array): Uint8Array {
  let quotes = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === QUOTE) quotes++;
  }
  if (quotes === 0) return bytes;
  const out = new Uint8Array(bytes.length - Math.floor(quotes / 2));
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === QUOTE && i + 1 < bytes.length && bytes[i + 1] === QUOTE) {
      out[o++] = QUOTE;
      i++;
    } else {
      out[o++] = bytes[i]!;
    }
  }
  return out.subarray(0, o);
}
