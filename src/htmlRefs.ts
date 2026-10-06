/** HTML 中发现的一处引用。 */
export interface HtmlReference {
  /** 属性值在原始字符串中的起始下标（含）。 */
  valueStart: number;
  /** 属性值在原始字符串中的结束下标（不含）。 */
  valueEnd: number;
  /** 属性值原文（未做实体还原）。 */
  rawValue: string;
}

/** 内容按原始文本处理、内部不解析标签的元素。 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

/**
 * 扫描 HTML 文本，返回元素上 href/src 属性的引用位置。
 * 属性名大小写无关；支持带引号与无引号属性值；
 * 注释与 script 等原始文本元素中的内容不算引用。
 */
export function findHtmlReferences(html: string): HtmlReference[] {
  const refs: HtmlReference[] = [];
  const len = html.length;
  let pos = 0;

  while (pos < len) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;
    const next = lt + 1 < len ? html.charCodeAt(lt + 1) : -1;

    if (next === 0x21 /* ! */) {
      // 注释或 <!DOCTYPE> 等声明。
      if (html.startsWith('!--', lt + 1)) {
        const end = html.indexOf('-->', lt + 4);
        pos = end < 0 ? len : end + 3;
      } else {
        const end = html.indexOf('>', lt + 1);
        pos = end < 0 ? len : end + 1;
      }
      continue;
    }
    if (next === 0x3f /* ? */) {
      const end = html.indexOf('>', lt + 1);
      pos = end < 0 ? len : end + 1;
      continue;
    }
    if (next === 0x2f /* / */) {
      // 结束标签：直接跳到 ">"。
      const end = html.indexOf('>', lt + 1);
      pos = end < 0 ? len : end + 1;
      continue;
    }
    if (!isAsciiLetter(next)) {
      // 不是标签起始，按普通文本处理。
      pos = lt + 1;
      continue;
    }

    // 起始标签：读取标签名。
    let cursor = lt + 1;
    while (cursor < len && /[A-Za-z0-9]/.test(html[cursor])) cursor++;
    const tagName = html.slice(lt + 1, cursor).toLowerCase();

    // 解析属性直到标签结束。
    let tagEnd = len;
    while (cursor < len) {
      while (cursor < len && isWhitespace(html.charCodeAt(cursor))) cursor++;
      const c = cursor < len ? html.charCodeAt(cursor) : -1;
      if (c === 0x3e /* > */) {
        tagEnd = cursor + 1;
        break;
      }
      if (c === 0x2f /* / */) {
        // 自闭合或孤立 "/"，跳过。
        cursor++;
        continue;
      }
      if (c < 0) {
        tagEnd = len;
        break;
      }
      // 属性名。
      const nameStart = cursor;
      while (cursor < len) {
        const code = html.charCodeAt(cursor);
        if (isWhitespace(code) || code === 0x3d /* = */ || code === 0x3e /* > */ || code === 0x2f /* / */) break;
        cursor++;
      }
      const attrName = html.slice(nameStart, cursor).toLowerCase();
      // 跳过空白后看是否有 "="。
      let lookahead = cursor;
      while (lookahead < len && isWhitespace(html.charCodeAt(lookahead))) lookahead++;
      if (lookahead < len && html.charCodeAt(lookahead) === 0x3d /* = */) {
        lookahead++;
        while (lookahead < len && isWhitespace(html.charCodeAt(lookahead))) lookahead++;
        if (lookahead < len && (html.charCodeAt(lookahead) === 0x22 /* " */ || html.charCodeAt(lookahead) === 0x27 /* ' */)) {
          const quote = html[lookahead];
          const valueStart = lookahead + 1;
          const valueEnd = html.indexOf(quote, valueStart);
          const end = valueEnd < 0 ? len : valueEnd;
          if (attrName === 'href' || attrName === 'src') {
            refs.push({ valueStart, valueEnd: end, rawValue: html.slice(valueStart, end) });
          }
          cursor = valueEnd < 0 ? len : valueEnd + 1;
        } else {
          // 无引号属性值。
          const valueStart = lookahead;
          let valueEnd = lookahead;
          while (valueEnd < len) {
            const code = html.charCodeAt(valueEnd);
            if (isWhitespace(code) || code === 0x3e /* > */) break;
            valueEnd++;
          }
          if (attrName === 'href' || attrName === 'src') {
            refs.push({ valueStart, valueEnd, rawValue: html.slice(valueStart, valueEnd) });
          }
          cursor = valueEnd;
        }
      } else {
        cursor = lookahead;
      }
    }
    pos = tagEnd;

    // 原始文本元素：跳过其内容直到对应的结束标签。
    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const closePattern = '</' + tagName;
      const lower = html.toLowerCase();
      const closeIndex = lower.indexOf(closePattern, pos);
      pos = closeIndex < 0 ? len : closeIndex;
    }
  }
  return refs;
}

/** 常见命名字符引用。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 按 HTML 规则还原属性值中的字符引用（命名/十进制/十六进制实体）。 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const codePoint = parseInt(digits, isHex ? 16 : 10);
      if (Number.isNaN(codePoint) || codePoint > 0x10ffff) return match;
      return String.fromCodePoint(codePoint);
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : match;
  });
}
