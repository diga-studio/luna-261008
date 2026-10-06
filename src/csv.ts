import type { CsvRecord } from './types.ts';

export interface CsvParseOk {
  ok: true;
  header: string[];
  records: CsvRecord[];
}

export interface CsvParseFatal {
  ok: false;
  reason: string;
}

export type CsvParseResult = CsvParseOk | CsvParseFatal;

const EXPECTED_HEADER = ['channel', 'reviewer_name', 'text', 'timestamp'];

/**
 * 解析完整 CSV 字节流（UTF-8，开头允许一个 BOM）。
 * 非法 UTF-8、表头不符、引号结构错误、未闭合引号、孤立 CR 均返回 ok:false。
 */
export function parseCsv(bytes: Uint8Array): CsvParseResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid UTF-8' };
  }
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
  }

  const records: CsvRecord[] = [];
  let curFields: string[] = [];
  let curField = '';
  let hasContent = false; // 当前记录是否已有任何内容（字符或分隔符）
  let state: 'start' | 'unquoted' | 'quoted' | 'afterQuote' = 'start';

  const endField = (): void => {
    curFields.push(curField);
    curField = '';
  };
  const endRecord = (): void => {
    endField();
    records.push({ index: records.length + 1, fields: curFields });
    curFields = [];
    hasContent = false;
    state = 'start';
  };

  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];
    if (ch === '\r') {
      // CR 只有在作为 CRLF 时合法；引号内原样保留两个字符。
      if (i + 1 >= len || text[i + 1] !== '\n') {
        return { ok: false, reason: `lone CR at offset ${i}` };
      }
      if (state === 'quoted') {
        curField += '\r\n';
        i += 2;
        continue;
      }
      // 记录结束（CRLF）
      endRecord();
      i += 2;
      continue;
    }
    if (ch === '\n') {
      if (state === 'quoted') {
        curField += '\n';
        i += 1;
        continue;
      }
      endRecord();
      i += 1;
      continue;
    }
    if (state === 'quoted') {
      if (ch === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          curField += '"';
          i += 2;
          continue;
        }
        state = 'afterQuote';
        i += 1;
        continue;
      }
      curField += ch;
      i += 1;
      continue;
    }
    if (state === 'afterQuote') {
      if (ch === ',') {
        endField();
        hasContent = true;
        state = 'start';
        i += 1;
        continue;
      }
      return { ok: false, reason: `unexpected character after closing quote at offset ${i}` };
    }
    // start 或 unquoted
    if (ch === '"') {
      if (state === 'unquoted') {
        return { ok: false, reason: `quote in unquoted field at offset ${i}` };
      }
      state = 'quoted';
      hasContent = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      hasContent = true;
      state = 'start';
      i += 1;
      continue;
    }
    curField += ch;
    hasContent = true;
    state = state === 'start' ? 'unquoted' : state;
    i += 1;
  }

  if (state === 'quoted') {
    return { ok: false, reason: 'unterminated quoted field at end of file' };
  }
  if (state === 'afterQuote' || hasContent || curField.length > 0 || curFields.length > 0) {
    endRecord();
  }

  if (records.length === 0) {
    return { ok: false, reason: 'missing header' };
  }
  const header = records[0].fields;
  if (header.length !== EXPECTED_HEADER.length || !EXPECTED_HEADER.every((h, idx) => header[idx] === h)) {
    return { ok: false, reason: 'header mismatch' };
  }
  const dataRecords = records.slice(1);
  // 重新编号：数据记录从 1 开始
  for (let r = 0; r < dataRecords.length; r += 1) {
    dataRecords[r].index = r + 1;
  }
  return { ok: true, header, records: dataRecords };
}
