/**
 * Persistent linked representation of an absolute access path.
 * Avoids storing a full path string per traversal state.
 */
export interface PathNode {
  readonly parent: PathNode | null;
  /** Last path component (empty string for the filesystem root "/"). */
  readonly name: string;
  /** Number of path components (root "/" has depth 0). */
  readonly depth: number;
}

export function pathRoot(): PathNode {
  return { parent: null, name: "", depth: 0 };
}

export function pathChild(parent: PathNode, name: string): PathNode {
  return { parent, name, depth: parent.depth + 1 };
}

/** Build a PathNode chain from a normalized absolute path string. */
export function pathFromString(path: string): PathNode {
  let node = pathRoot();
  for (const part of path.split("/")) {
    if (part.length > 0) node = pathChild(node, part);
  }
  return node;
}

/** Materialize the absolute path string. */
export function pathToString(node: PathNode): string {
  const parts: string[] = [];
  let cur: PathNode | null = node;
  while (cur !== null && cur.parent !== null) {
    parts.push(cur.name);
    cur = cur.parent;
  }
  parts.reverse();
  return "/" + parts.join("/");
}

function components(node: PathNode): string[] {
  const parts: string[] = [];
  let cur: PathNode | null = node;
  while (cur !== null && cur.parent !== null) {
    parts.push(cur.name);
    cur = cur.parent;
  }
  parts.reverse();
  return parts;
}

/** Compare two strings by Unicode code points (equivalent to UTF-8 byte order). */
function compareCodePoints(a: string, b: string): number {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const ca = aa[i].codePointAt(0)!;
    const cb = bb[i].codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  if (aa.length === bb.length) return 0;
  return aa.length < bb.length ? -1 : 1;
}

/**
 * Compare two paths of equal depth by UTF-8 byte order of the full path
 * string, where end-of-string is treated as the virtual byte `eofByte`.
 * Component separators are always the byte 0x2F ("/").
 * Callers must ensure a.depth === b.depth.
 */
export function compareEqualDepth(a: PathNode, b: PathNode, eofByte: number): number {
  if (a === b) return 0;
  const ca = components(a);
  const cb = components(b);
  for (let k = 0; k < ca.length; k++) {
    const last = k === ca.length - 1;
    const tailByte = last ? eofByte : 0x2f;
    const sa = Array.from(ca[k]);
    const sb = Array.from(cb[k]);
    const n = Math.min(sa.length, sb.length);
    for (let i = 0; i < n; i++) {
      const xa = sa[i].codePointAt(0)!;
      const xb = sb[i].codePointAt(0)!;
      if (xa !== xb) return xa < xb ? -1 : 1;
    }
    if (sa.length !== sb.length) {
      // The shorter component is followed by `tailByte` in its stream, the
      // longer one by its next code point (never 0x2F inside a component).
      const shortIsA = sa.length < sb.length;
      const nextLong = (shortIsA ? sb[sa.length] : sa[sb.length]).codePointAt(0)!;
      if (tailByte !== nextLong) return tailByte < nextLong ? (shortIsA ? -1 : 1) : shortIsA ? 1 : -1;
      // tailByte can never equal a component byte (0x2F is not allowed in
      // names, and eofByte differs from every real byte), so this is unreachable.
    }
  }
  return 0;
}

/**
 * Traversal order: fewer components first; ties broken by byte order with
 * end-of-string treated as "/" (0x2F). Extension-invariant: for any suffix
 * s, a <= b in this order iff a+s <= b+s.
 */
export function compareTraversal(a: PathNode, b: PathNode): number {
  if (a.depth !== b.depth) return a.depth < b.depth ? -1 : 1;
  return compareEqualDepth(a, b, 0x2f);
}

/**
 * Representative-path order: fewer components first; ties broken by plain
 * UTF-8 byte order (end-of-string sorts before any real byte).
 */
export function compareRepresentative(a: PathNode, b: PathNode): number {
  if (a.depth !== b.depth) return a.depth < b.depth ? -1 : 1;
  return compareEqualDepth(a, b, -1);
}

export { compareCodePoints };
