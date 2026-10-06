import { ImportFileError } from './types.js';

export interface CsvRecord {
  /** 1-based logical record number including the header record. */
  recordNumber: number;
  fields: string[];
}

const enum State {
  FieldStart,
  InField,
  InQuoted,
  QuoteInQuoted,
  AfterCr,
}

/** UTF-8 byte length of one code unit; a surrogate pair sums to 4. */
function unitBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 2;
  return 3;
}

/**
 * Streaming RFC 4180 parser that additionally accepts LF record separators.
 * Handles quoted commas, doubled quotes and multi-line quoted fields.
 * Byte chunks may split anywhere, including inside UTF-8 sequences, CRLF
 * pairs and escaped quotes.
 */
export async function* parseCsv(
  chunks: AsyncIterable<Uint8Array>,
  maxRecordBytes: number,
): AsyncGenerator<CsvRecord> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let state: State = State.FieldStart;
  let fields: string[] = [];
  let current = '';
  let recordOpen = false;
  let recordBytes = 0;
  let recordNumber = 0;
  let bomChecked = false;

  const feedChar = (ch: string, bytes: number): CsvRecord | null => {
    if (!bomChecked) {
      bomChecked = true;
      if (ch === '﻿') return null;
    }
    if (state !== State.AfterCr) {
      recordBytes += bytes;
      if (recordBytes > maxRecordBytes) {
        throw new ImportFileError('RECORD_TOO_LARGE', 'record exceeds 64 KiB');
      }
    }
    switch (state) {
      case State.FieldStart:
        if (ch === '"') {
          recordOpen = true;
          state = State.InQuoted;
        } else if (ch === ',') {
          recordOpen = true;
          fields.push('');
        } else if (ch === '\r') {
          recordOpen = true;
          state = State.AfterCr;
          return finishRecord();
        } else if (ch === '\n') {
          recordOpen = true;
          return finishRecord();
        } else {
          recordOpen = true;
          current += ch;
          state = State.InField;
        }
        return null;
      case State.InField:
        if (ch === ',') {
          fields.push(current);
          current = '';
          state = State.FieldStart;
        } else if (ch === '\r') {
          state = State.AfterCr;
          fields.push(current);
          current = '';
          return finishRecord();
        } else if (ch === '\n') {
          fields.push(current);
          current = '';
          state = State.FieldStart;
          return finishRecord();
        } else {
          current += ch;
        }
        return null;
      case State.InQuoted:
        if (ch === '"') {
          state = State.QuoteInQuoted;
        } else {
          current += ch;
        }
        return null;
      case State.QuoteInQuoted:
        if (ch === '"') {
          current += '"';
          state = State.InQuoted;
        } else if (ch === ',') {
          fields.push(current);
          current = '';
          state = State.FieldStart;
        } else if (ch === '\r') {
          state = State.AfterCr;
          fields.push(current);
          current = '';
          return finishRecord();
        } else if (ch === '\n') {
          fields.push(current);
          current = '';
          state = State.FieldStart;
          return finishRecord();
        } else {
          throw new ImportFileError(
            'CSV_SYNTAX',
            `unexpected character after closing quote in record ${recordNumber + 1}`,
          );
        }
        return null;
      case State.AfterCr:
        // The CR already terminated the record; swallow one following LF.
        state = State.FieldStart;
        if (ch === '\n') return null;
        return feedChar(ch, 0);
    }
  };

  const finishRecord = (): CsvRecord => {
    recordNumber += 1;
    const record: CsvRecord = { recordNumber, fields };
    fields = [];
    current = '';
    recordOpen = false;
    recordBytes = 0;
    return record;
  };

  const feedText = (text: string): CsvRecord[] => {
    const out: CsvRecord[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      const rec = feedChar(ch, unitBytes(ch.charCodeAt(0)));
      if (rec) out.push(rec);
    }
    return out;
  };

  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = chunks[Symbol.asyncIterator]();
  } catch (err) {
    throw new ImportFileError('STREAM_ERROR', `input stream failed: ${String(err)}`);
  }

  for (;;) {
    let step: IteratorResult<Uint8Array>;
    try {
      step = await iterator.next();
    } catch (err) {
      throw new ImportFileError('STREAM_ERROR', `input stream failed: ${String(err)}`);
    }
    if (step.done) break;
    let text: string;
    try {
      text = decoder.decode(step.value, { stream: true });
    } catch {
      throw new ImportFileError('INVALID_UTF8', 'input is not valid UTF-8');
    }
    for (const rec of feedText(text)) {
      yield rec;
    }
  }

  let tail: string;
  try {
    tail = decoder.decode();
  } catch {
    throw new ImportFileError('INVALID_UTF8', 'truncated UTF-8 sequence at end of input');
  }
  for (const rec of feedText(tail)) {
    yield rec;
  }

  const endState = (): State => state;
  if (endState() === State.InQuoted) {
    throw new ImportFileError('CSV_SYNTAX', 'unterminated quoted field at end of input');
  }
  if (endState() === State.QuoteInQuoted) {
    fields.push(current);
    current = '';
    yield finishRecord();
    return;
  }
  if (recordOpen) {
    fields.push(current);
    current = '';
    yield finishRecord();
  }
}
