/** A located href/src attribute value inside an HTML document. */
export interface HtmlRef {
  /** Raw attribute value exactly as it appears in the source. */
  rawValue: string;
  /** Offset of the first character of the raw value inside the source. */
  valueStart: number;
  /** Offset one past the last character of the raw value. */
  valueEnd: number;
}

/**
 * Scans HTML source and returns every href/src attribute value found on
 * elements. Attribute names are matched case-insensitively; quoted and
 * unquoted values are supported. Comments and script/style raw text are
 * skipped, so apparent references inside them are not reported.
 */
export function extractHtmlRefs(html: string): HtmlRef[] {
  const refs: HtmlRef[] = [];
  const len = html.length;
  let pos = 0;
  while (pos < len) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) break;
    const next = lt + 1 < len ? html[lt + 1] : "";
    if (next === "!") {
      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 4);
        pos = end === -1 ? len : end + 3;
      } else {
        const end = html.indexOf(">", lt + 2);
        pos = end === -1 ? len : end + 1;
      }
      continue;
    }
    if (next === "?" || next === "/" || !isAsciiLetter(next)) {
      pos = lt + 1;
      continue;
    }
    // Opening tag: read the tag name.
    let cursor = lt + 1;
    while (cursor < len && isTagNameChar(html[cursor])) cursor++;
    const tagName = html.slice(lt + 1, cursor).toLowerCase();
    cursor = scanTagBody(html, cursor, refs);
    if (tagName === "script" || tagName === "style") {
      cursor = skipRawText(html, cursor, tagName);
    }
    pos = cursor;
  }
  return refs;
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isTagNameChar(ch: string): boolean {
  return isAsciiLetter(ch) || (ch >= "0" && ch <= "9") || ch === "-" || ch === ":";
}

function isHtmlSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** Scans from just after the tag name to one past the closing '>'. */
function scanTagBody(html: string, start: number, refs: HtmlRef[]): number {
  const len = html.length;
  let cursor = start;
  while (cursor < len) {
    const ch = html[cursor];
    if (ch === ">") return cursor + 1;
    if (ch === "/" ) {
      // A '/' directly before '>' ends the tag; otherwise it is skipped.
      let look = cursor + 1;
      while (look < len && isHtmlSpace(html[look])) look++;
      if (look < len && html[look] === ">") return look + 1;
      cursor++;
      continue;
    }
    if (isHtmlSpace(ch)) {
      cursor++;
      continue;
    }
    // Attribute name.
    const nameStart = cursor;
    while (cursor < len) {
      const c = html[cursor];
      if (c === "=" || c === ">" || c === "/" || isHtmlSpace(c)) break;
      cursor++;
    }
    const attrName = html.slice(nameStart, cursor).toLowerCase();
    // Optional '=' after whitespace.
    let look = cursor;
    while (look < len && isHtmlSpace(html[look])) look++;
    if (look >= len || html[look] !== "=") {
      cursor = look;
      continue;
    }
    look++;
    while (look < len && isHtmlSpace(html[look])) look++;
    if (look >= len) return len;
    const quote = html[look];
    let valueStart: number;
    let valueEnd: number;
    let after: number;
    if (quote === '"' || quote === "'") {
      valueStart = look + 1;
      const close = html.indexOf(quote, valueStart);
      if (close === -1) return len;
      valueEnd = close;
      after = close + 1;
    } else {
      valueStart = look;
      let end = look;
      while (end < len && !isHtmlSpace(html[end]) && html[end] !== ">") end++;
      valueEnd = end;
      after = end;
    }
    if (attrName === "href" || attrName === "src") {
      refs.push({
        rawValue: html.slice(valueStart, valueEnd),
        valueStart,
        valueEnd,
      });
    }
    cursor = after;
  }
  return cursor;
}

/** Skips raw text of script/style up to and including the closing tag. */
function skipRawText(html: string, start: number, tagName: string): number {
  const closer = "</" + tagName;
  const len = html.length;
  let cursor = start;
  while (cursor < len) {
    const idx = html.toLowerCase().indexOf(closer, cursor);
    if (idx === -1) return len;
    const afterName = idx + closer.length;
    const ch = afterName < len ? html[afterName] : "";
    if (ch === "" || ch === ">" || ch === "/" || isHtmlSpace(ch)) {
      const end = html.indexOf(">", afterName);
      return end === -1 ? len : end + 1;
    }
    cursor = afterName;
  }
  return len;
}

/**
 * Decodes HTML character references (numeric and common named entities)
 * in an attribute value.
 */
export function decodeHtmlEntities(value: string): string {
  if (value.indexOf("&") === -1) return value;
  return value.replace(
    /&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (whole, body: string) => {
      if (body[0] === "#") {
        const isHex = body[1] === "x" || body[1] === "X";
        const digits = isHex ? body.slice(2) : body.slice(1);
        const code = parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
        if (code >= 0xd800 && code <= 0xdfff) return whole;
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    },
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  times: "×",
  divide: "÷",
  plusmn: "±",
  deg: "°",
  micro: "µ",
  para: "¶",
  sect: "§",
};
