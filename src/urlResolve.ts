/** Result of resolving a local URL against its containing HTML file. */
export interface ResolvedRef {
  /** Normalized source-relative path (no query/fragment). */
  sourcePath: string;
  /** Original query string including '?', or "" if absent. */
  query: string;
  /** Original fragment including '#', or "" if absent. */
  fragment: string;
}

/**
 * Returns true when the (already entity-decoded) URL is external and must
 * be preserved as-is: "https:"/"data:" URLs, or anything else carrying a
 * scheme, host or leading slash.
 */
export function isExternalUrl(url: string): boolean {
  if (url.startsWith("//") || url.startsWith("/")) return true;
  // Any scheme ("https:", "data:", "http:", "mailto:", ...) is external.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * Resolves a local URL against the directory of the HTML file that
 * contains it. Each path segment is percent-decoded once as UTF-8, then
 * "." and ".." segments are eliminated. An empty path refers to the
 * containing HTML file itself. Query and fragment are split off before
 * resolution and returned untouched.
 */
export function resolveLocalUrl(url: string, htmlSourcePath: string): ResolvedRef {
  let rest = url;
  let fragment = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) {
    fragment = rest.slice(hashIdx);
    rest = rest.slice(0, hashIdx);
  }
  let query = "";
  const queryIdx = rest.indexOf("?");
  if (queryIdx !== -1) {
    query = rest.slice(queryIdx);
    rest = rest.slice(0, queryIdx);
  }
  if (rest === "") {
    // Empty path refers to the containing HTML file itself.
    return { sourcePath: htmlSourcePath, query, fragment };
  }
  // Relative references start from the containing HTML's directory.
  const stack = htmlSourcePath.split("/").slice(0, -1);
  for (const rawSegment of rest.split("/")) {
    const segment = decodeSegment(rawSegment);
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return { sourcePath: stack.join("/"), query, fragment };
}

/**
 * Percent-decodes one path segment as UTF-8, exactly once. Invalid
 * percent sequences and stray '%' characters are left untouched.
 */
function decodeSegment(segment: string): string {
  if (segment.indexOf("%") === -1) return segment;
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "%" && i + 2 < segment.length && isHexDigit(segment[i + 1]) && isHexDigit(segment[i + 2])) {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    const encoded = Buffer.from(ch, "utf8");
    for (const byte of encoded) bytes.push(byte);
  }
  return Buffer.from(bytes).toString("utf8");
}

function isHexDigit(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    ((ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F"))
  );
}
