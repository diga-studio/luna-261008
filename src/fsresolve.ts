import { lstatSync, readlinkSync, statSync } from "node:fs";
import { posix } from "node:path";

export type EntryKind = "file" | "dir" | "other";

export interface EntityInfo {
  kind: EntryKind;
  dev: number;
  ino: number;
}

function splitComponents(path: string): string[] {
  return path.split("/").filter((p) => p.length > 0 && p !== ".");
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

/**
 * Resolve an absolute path to a canonical, symlink-free absolute path,
 * following file and directory symlinks (including links pointing anywhere).
 * Returns null for dangling links, symlink loops, or unresolvable paths.
 *
 * Resolution walks component by component, always keeping the already-walked
 * prefix canonical (symlink-free). The kernel therefore never has to expand
 * more than one symlink per lookup, so arbitrarily long link chains and
 * link loops do not hit the kernel's nested-symlink limit (ELOOP).
 */
export function resolveCanonical(path: string): string | null {
  let comps = splitComponents(path);
  let cur = "/";
  let i = 0;
  // A resolution is a deterministic machine over (expanded link, remaining
  // components); a repeated configuration means a symlink loop.
  const seen = new Set<string>();
  while (i < comps.length) {
    const comp = comps[i];
    i++;
    if (comp === "..") {
      cur = dirnameOf(cur);
      continue;
    }
    cur = joinPath(cur, comp);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(cur);
      } catch {
        return null;
      }
      const rest = comps.slice(i);
      const configuration = cur + "\0" + rest.join("/");
      if (seen.has(configuration)) return null;
      seen.add(configuration);
      if (posix.isAbsolute(target)) {
        comps = splitComponents(target).concat(rest);
      } else {
        // Relative targets are interpreted against the canonical directory
        // containing the link, which is already symlink-free.
        comps = splitComponents(dirnameOf(cur)).concat(splitComponents(target), rest);
      }
      cur = "/";
      i = 0;
    }
  }
  return cur;
}

const entityCache = new Map<string, EntityInfo | null>();

/** Stat a canonical (symlink-free) path, with caching. */
export function entityOfCanonical(canonical: string): EntityInfo | null {
  const cached = entityCache.get(canonical);
  if (cached !== undefined) return cached;
  let info: EntityInfo | null = null;
  try {
    const st = statSync(canonical);
    info = {
      kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
      dev: st.dev,
      ino: st.ino,
    };
  } catch {
    info = null;
  }
  entityCache.set(canonical, info);
  return info;
}

const canonicalCache = new Map<string, string | null>();

/** Canonical (symlink-free) form of an absolute path, with caching. */
export function canonicalOf(path: string): string | null {
  const cached = canonicalCache.get(path);
  if (cached !== undefined) return cached;
  const canonical = resolveCanonical(path);
  canonicalCache.set(path, canonical);
  return canonical;
}

/** Resolve any absolute path to the underlying entity, following symlinks. */
export function entityOfPath(path: string): EntityInfo | null {
  const canonical = canonicalOf(path);
  return canonical === null ? null : entityOfCanonical(canonical);
}

/**
 * Describe one directory entry inside a directory whose canonical path is
 * `dirCanonical`. Uses lstat so the kernel follows no symlinks; symlink
 * entries are resolved manually.
 */
export function entryInfo(dirCanonical: string, name: string): EntityInfo | null {
  const full = joinPath(dirCanonical, name);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return null;
  }
  if (!st.isSymbolicLink()) {
    return {
      kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
      dev: st.dev,
      ino: st.ino,
    };
  }
  return entityOfPath(full);
}
