/** 解析后的分部首部。 */
export interface PartHeaders {
  /** 小写媒体类型，缺省 "text/plain"。 */
  mediaType: string;
  /** 小写 charset 参数，缺省 "us-ascii"。 */
  charset: string;
  /** 小写传输编码，缺省 "7bit"。 */
  transferEncoding: string;
  /** multipart 的 boundary 参数（若有，大小写保留）。 */
  boundary?: string;
}

/** 单个分部首部的最大字节数（8 KiB）。 */
export const HEADER_LIMIT = 8 * 1024;

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const TAB = 0x09;

function isWsp(code: number): boolean {
  return code === SP || code === TAB;
}

/** 把原始首部字节拆成逻辑行（处理折叠），返回 [name, value][]。 */
function unfold(raw: Uint8Array): Array<[string, string]> {
  const lines: string[] = [];
  let current = "";
  let i = 0;
  while (i < raw.length) {
    const b = raw[i]!;
    if (b === CR && raw[i + 1] === LF) {
      lines.push(current);
      current = "";
      i += 2;
    } else if (b === LF) {
      lines.push(current);
      current = "";
      i += 1;
    } else {
      current += String.fromCharCode(b);
      i += 1;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }

  const fields: Array<[string, string]> = [];
  for (const line of lines) {
    const first = line.charCodeAt(0);
    if (isWsp(first)) {
      // 折叠行：并入上一个字段。
      if (fields.length === 0) {
        throw new Error("header block starts with a continuation line");
      }
      fields[fields.length - 1]![1] += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(`malformed header line: ${JSON.stringify(line)}`);
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    fields.push([name, value]);
  }
  return fields;
}

/** 解析分号分隔的参数段，返回小写参数名到值的映射。 */
function parseParams(value: string): { main: string; params: Map<string, string> } {
  const segments: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (inQuote) {
      if (ch === "\\" && i + 1 < value.length) {
        // 引号内反斜线转义下一个字符。
        current += value[i + 1]!;
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ";") {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (inQuote) {
    throw new Error("unterminated quoted-string in header value");
  }
  segments.push(current);

  const main = segments[0]!.trim().toLowerCase();
  const params = new Map<string, string>();
  for (let i = 1; i < segments.length; i++) {
    const eq = segments[i]!.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = segments[i]!.slice(0, eq).trim().toLowerCase();
    const paramValue = segments[i]!.slice(eq + 1).trim();
    if (name.length > 0 && !params.has(name)) {
      params.set(name, paramValue);
    }
  }
  return { main, params };
}

function validateBoundary(boundary: string): void {
  if (boundary.length === 0 || boundary.length > 70) {
    throw new Error(`invalid boundary length: ${boundary.length}`);
  }
  for (const ch of boundary) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) {
      throw new Error("boundary must be printable ASCII");
    }
  }
}

/**
 * 解析一段原始首部字节（ASCII，可能含折叠行），不含结尾的空行。
 * 首部名称、媒体类型与编码名称大小写不敏感；参数值可为带引号字符串，
 * 引号内反斜线转义下一个字符。
 */
export function parseHeaders(raw: Uint8Array): PartHeaders {
  if (raw.length > HEADER_LIMIT) {
    throw new Error(`header block exceeds ${HEADER_LIMIT} bytes`);
  }
  const fields = unfold(raw);

  let mediaType = "text/plain";
  let charset = "us-ascii";
  let transferEncoding = "7bit";
  let boundary: string | undefined;

  for (const [name, value] of fields) {
    if (name === "content-type") {
      const { main, params } = parseParams(value);
      if (main.length > 0 && main.includes("/")) {
        mediaType = main;
      }
      const cs = params.get("charset");
      if (cs !== undefined && cs.length > 0) {
        charset = cs.toLowerCase();
      }
      const b = params.get("boundary");
      if (b !== undefined) {
        boundary = b;
      }
    } else if (name === "content-transfer-encoding") {
      const token = value.trim().toLowerCase();
      if (token.length > 0) {
        transferEncoding = token;
      }
    }
  }

  if (mediaType.startsWith("multipart/")) {
    if (boundary === undefined) {
      throw new Error(`multipart media type ${mediaType} missing boundary`);
    }
    validateBoundary(boundary);
  }

  const result: PartHeaders = { mediaType, charset, transferEncoding };
  if (boundary !== undefined) {
    result.boundary = boundary;
  }
  return result;
}
