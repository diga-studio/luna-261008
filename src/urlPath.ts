/** 解析后的本地 URL。 */
export interface LocalUrl {
  /** 百分号解码并消除 "." / ".." 之后的路径（空串表示当前 HTML）。 */
  path: string;
  /** 原始查询串（含前导 "?"），原样保留。 */
  query: string;
  /** 原始片段（含前导 "#"），原样保留。 */
  fragment: string;
}

/** 判断 URL 是否为外部保留 URL（https: / data: 开头，协议名大小写无关）。 */
export function isExternalUrl(url: string): boolean {
  const lower = url.slice(0, 6).toLowerCase();
  return lower.startsWith('https:') || lower.startsWith('data:');
}

/** 判断 URL 是否为本地 URL（无协议、无主机、无前导斜杠）。 */
export function isLocalUrl(url: string): boolean {
  if (url.startsWith('/') || url.startsWith('\\')) return false;
  // 任何形式的 scheme（如 http:、javascript:）都不是本地 URL。
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return false;
  return true;
}

/** 对单个路径段做一次 UTF-8 百分号解码；非法序列原样保留。 */
function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  const bytes: number[] = [];
  let hasEncoded = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charCodeAt(i);
    if (
      ch === 0x25 /* % */ &&
      i + 2 < segment.length + 1 &&
      /^[0-9A-Fa-f]{2}$/.test(segment.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
      i += 2;
      hasEncoded = true;
    } else {
      // 非 ASCII 字符按 UTF-8 重新编码为字节，保证整体按 UTF-8 解释。
      const s = segment[i];
      const utf8 = Buffer.from(s, 'utf8');
      for (const b of utf8) bytes.push(b);
    }
  }
  if (!hasEncoded) return segment;
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 解析本地 URL：先按 HTML 规则还原属性值（调用方已完成），
 * 再逐路径段做一次 UTF-8 百分号解码，相对 baseDir 消除 "." 和 ".."。
 * baseDir 为引用所在 HTML 的目录（POSIX 风格相对路径，根目录为 ""）。
 * 查询参数与片段不参与路径解析，原样保留。
 */
export function resolveLocalUrl(rawUrl: string, baseDir: string): LocalUrl {
  let rest = rawUrl;
  let fragment = '';
  const hashIndex = rest.indexOf('#');
  if (hashIndex >= 0) {
    fragment = rest.slice(hashIndex);
    rest = rest.slice(0, hashIndex);
  }
  let query = '';
  const queryIndex = rest.indexOf('?');
  if (queryIndex >= 0) {
    query = rest.slice(queryIndex);
    rest = rest.slice(0, queryIndex);
  }

  if (rest === '') {
    // 空路径（仅查询/片段或空串）指当前 HTML。
    return { path: '', query, fragment };
  }
  const segments = rest.split('/').map(decodeSegment);
  const baseSegments = baseDir === '' ? [] : baseDir.split('/');
  const out = baseSegments.slice();
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return { path: out.join('/'), query, fragment };
}

/** 将包内相对路径转为可供 HTML 属性使用的 URL（逐段百分号编码）。 */
export function encodePackageUrl(packagePath: string): string {
  return packagePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
