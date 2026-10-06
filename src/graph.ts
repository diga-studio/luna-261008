import type { CourseSnapshot } from "./types.ts";
import { decodeHtmlEntities, extractHtmlRefs, type HtmlRef } from "./htmlRefs.ts";
import { isExternalUrl, resolveLocalUrl } from "./urlResolve.ts";
import { rewriteHtml } from "./rewrite.ts";

/** Reads a snapshot source file; returns null when it does not exist. */
export type SourceReader = (sourcePath: string) => Buffer | null;

export interface ClosureResult {
  /** All reachable source paths, in deterministic discovery order. */
  reachable: string[];
  /** Per module index: source paths reachable from that module's entry. */
  perModule: string[][];
  /** Rewritten HTML content keyed by source path (only HTML files). */
  rewrittenHtml: Map<string, string>;
  /** File contents keyed by source path for every reachable file. */
  contents: Map<string, Buffer>;
  /** Maps source-relative path -> assigned package path. */
  pathMap: Map<string, string>;
}

interface ParsedLink {
  external: boolean;
  target?: string;
  query?: string;
  fragment?: string;
}

interface ParsedHtml {
  source: string;
  refs: HtmlRef[];
  links: ParsedLink[];
}

/**
 * Computes the reachable closure of every module entry by following local
 * href/src references. Only HTML files are parsed for further references;
 * every other file is a self-contained leaf. Cycles terminate. HTML files
 * with identical bytes in different directories are resolved independently
 * against their own directory.
 *
 * Package paths are assigned to every reachable file and HTML references
 * are rewritten to point at the assigned package paths (query and
 * fragment preserved verbatim).
 */
export function computeClosures(
  snapshot: CourseSnapshot,
  read: SourceReader,
  assignPackagePath: (sourcePath: string, isHtml: boolean) => string,
): ClosureResult {
  const entryPaths = new Set(snapshot.modules.map((m) => m.entry));
  const isHtmlPath = (p: string): boolean =>
    entryPaths.has(p) || /\.(html|htm)$/i.test(p);

  const pathMap = new Map<string, string>();
  const contents = new Map<string, Buffer>();
  const parsedHtml = new Map<string, ParsedHtml>();

  const ensurePacked = (sourcePath: string): void => {
    if (!pathMap.has(sourcePath)) {
      pathMap.set(sourcePath, assignPackagePath(sourcePath, isHtmlPath(sourcePath)));
    }
  };

  const readRequired = (sourcePath: string): Buffer => {
    let data = contents.get(sourcePath);
    if (data === undefined) {
      data = read(sourcePath);
      if (data === null) {
        throw new Error(`missing source file: ${sourcePath}`);
      }
      contents.set(sourcePath, data);
    }
    return data;
  };

  const parseHtml = (sourcePath: string): ParsedHtml => {
    const cached = parsedHtml.get(sourcePath);
    if (cached !== undefined) return cached;
    const source = readRequired(sourcePath).toString("utf8");
    const refs = extractHtmlRefs(source);
    const links: ParsedLink[] = refs.map((ref) => {
      const decoded = decodeHtmlEntities(ref.rawValue);
      if (isExternalUrl(decoded)) return { external: true };
      const resolved = resolveLocalUrl(decoded, sourcePath);
      return {
        external: false,
        target: resolved.sourcePath,
        query: resolved.query,
        fragment: resolved.fragment,
      };
    });
    const parsed: ParsedHtml = { source, refs, links };
    parsedHtml.set(sourcePath, parsed);
    return parsed;
  };

  // Breadth-first traversal per module, in module order. Path assignment
  // happens on first discovery, keeping the package layout deterministic.
  const perModule: string[][] = [];
  for (const courseModule of snapshot.modules) {
    const visited = new Set<string>();
    const queue: string[] = [];
    const closure: string[] = [];
    visited.add(courseModule.entry);
    queue.push(courseModule.entry);
    ensurePacked(courseModule.entry);
    readRequired(courseModule.entry);
    while (queue.length > 0) {
      const current = queue.shift() as string;
      closure.push(current);
      if (!isHtmlPath(current)) continue;
      for (const link of parseHtml(current).links) {
        if (link.external) continue;
        const target = link.target as string;
        ensurePacked(target);
        readRequired(target);
        if (!visited.has(target)) {
          visited.add(target);
          queue.push(target);
        }
      }
    }
    perModule.push(closure);
  }

  // Rewrite every parsed HTML once all package paths are assigned.
  const rewrittenHtml = new Map<string, string>();
  for (const [sourcePath, parsed] of parsedHtml) {
    const fromPackage = pathMap.get(sourcePath) as string;
    const replacements = parsed.links.map((link) => {
      if (link.external) return null;
      const toPackage = pathMap.get(link.target as string) as string;
      return (
        relativePackagePath(fromPackage, toPackage) +
        (link.query ?? "") +
        (link.fragment ?? "")
      );
    });
    rewrittenHtml.set(sourcePath, rewriteHtml(parsed.source, parsed.refs, replacements));
  }

  return {
    reachable: Array.from(pathMap.keys()),
    perModule,
    rewrittenHtml,
    contents,
    pathMap,
  };
}

/** Computes a relative path between two package paths. */
function relativePackagePath(fromPackage: string, toPackage: string): string {
  const fromDir = fromPackage.split("/").slice(0, -1);
  const toParts = toPackage.split("/");
  let common = 0;
  while (
    common < fromDir.length &&
    common < toParts.length - 1 &&
    fromDir[common] === toParts[common]
  ) {
    common++;
  }
  const ups = fromDir.length - common;
  return "../".repeat(ups) + toParts.slice(common).join("/");
}
