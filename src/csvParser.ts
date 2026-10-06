import type { RawRecord } from './types.js';

/** 解析失败（整批失败）时抛出。 */
export class CsvParseError extends Error {}

const EXPECTED_HEADER = ['channel', 'reviewer_name', 'text', 'timestamp'];

type State = 'FIELD_START' | 'UNQUOTED' | 'QUOTED' | 'AFTER_QUOTE';

async function readAllBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvParseError('invalid UTF-8');
  }
  // 开头允许一个 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let state: State = 'FIELD_START';
  let i = 0;
  const n = text.length;

  const endRecord = () => {
    records.push(fields);
    fields = [];
    state = 'FIELD_START';
  };
  const endField = () => {
    fields.push(field);
    field = '';
  };
  // 读取记录结束符：LF 或 CRLF；单独出现的 CR 不合法
  const readTerminator = (pos: number): number => {
    const c = text[pos];
    if (c === '\n') return pos + 1;
    // c === '\r'
    if (pos + 1 < n && text[pos + 1] === '\n') return pos + 2;
    throw new CsvParseError('lone CR is not allowed');
  };

  while (i < n) {
    const c = text[i];
    switch (state) {
      case 'FIELD_START':
        if (c === '"') {
          state = 'QUOTED';
          i++;
        } else if (c === ',') {
          endField();
          i++;
        } else if (c === '\n' || c === '\r') {
          endField();
          i = readTerminator(i);
          endRecord();
        } else {
          field += c;
          state = 'UNQUOTED';
          i++;
        }
        break;
      case 'UNQUOTED':
        if (c === ',') {
          endField();
          state = 'FIELD_START';
          i++;
        } else if (c === '\n' || c === '\r') {
          endField();
          i = readTerminator(i);
          endRecord();
        } else if (c === '"') {
          throw new CsvParseError('double quote in unquoted field');
        } else {
          field += c;
          i++;
        }
        break;
      case 'QUOTED':
        if (c === '"') {
          state = 'AFTER_QUOTE';
        } else {
          field += c; // 逗号、换行等原样保留
        }
        i++;
        break;
      case 'AFTER_QUOTE':
        if (c === '"') {
          field += '"';
          state = 'QUOTED';
          i++;
        } else if (c === ',') {
          endField();
          state = 'FIELD_START';
          i++;
        } else if (c === '\n' || c === '\r') {
          endField();
          i = readTerminator(i);
          endRecord();
        } else {
          throw new CsvParseError('unexpected character after closing quote');
        }
        break;
    }
  }

  // 文件结束
  if (state === 'QUOTED') {
    throw new CsvParseError('unclosed quote at end of file');
  }
  if (state === 'AFTER_QUOTE' || state === 'UNQUOTED') {
    endField();
    endRecord();
  } else if (fields.length > 0) {
    // FIELD_START 且已有字段：最后一个字段为空（如 "a," 结尾）
    endField();
    endRecord();
  }
  // 否则：末尾的记录结束符不额外产生空记录
  return records;
}

/**
 * 把一次性字节流解析为原始记录序列。
 * 负责：UTF-8 校验、BOM、表头校验、引号状态机。
 * 引号结构错误 / 未闭合引号 / lone CR / 非法 UTF-8 / 表头不符 均抛 CsvParseError。
 */
export async function parseCsvStream(
  stream: AsyncIterable<Uint8Array>,
): Promise<RawRecord[]> {
  const bytes = await readAllBytes(stream);
  const text = decodeUtf8(bytes);
  const records = parseRecords(text);

  const header = records[0];
  if (
    !header ||
    header.length !== EXPECTED_HEADER.length ||
    !EXPECTED_HEADER.every((name, idx) => header[idx] === name)
  ) {
    throw new CsvParseError('header mismatch');
  }

  return records.slice(1).map((fields, idx) => ({
    recordIndex: idx + 1,
    fields,
  }));
}
