import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";

/** A version retained on disk and listed in metadata. */
export interface VersionRecord {
  version: number;
  sha256: string;
  size: number;
}

/** Permanent record of a committed requestId. */
export interface RequestRecord {
  kind: "publish" | "rollback";
  /** Version produced when the request committed. */
  version: number;
  /** publish: SHA-256 of the source bytes that were published. */
  sourceSha256?: string;
  /** rollback: the historical version whose content was republished. */
  rollbackFrom?: number;
}

/** On-disk metadata for one logical output. */
export interface OutputMeta {
  output: string;
  currentVersion: number | null;
  nextVersion: number;
  versions: VersionRecord[];
  requests: Record<string, RequestRecord>;
}

/** Filesystem layout for one output. */
export interface OutputLayout {
  dir: string;
  deliveryPath: string;
  metaPath: string;
  versionsDir: string;
  versionFile: (version: number) => string;
}

export function outputLayout(rootDir: string, output: string): OutputLayout {
  const dir = join(rootDir, "outputs", encodeURIComponent(output));
  const versionsDir = join(dir, "versions");
  return {
    dir,
    deliveryPath: join(dir, "current"),
    metaPath: join(dir, "meta.json"),
    versionsDir,
    versionFile: (version) => join(versionsDir, String(version)),
  };
}

export function emptyMeta(output: string): OutputMeta {
  return {
    output,
    currentVersion: null,
    nextVersion: 1,
    versions: [],
    requests: {},
  };
}

/** Load metadata, or return a fresh record when none exists yet. */
export async function loadMeta(layout: OutputLayout, output: string): Promise<OutputMeta> {
  try {
    const raw = await readFile(layout.metaPath, "utf8");
    return JSON.parse(raw) as OutputMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyMeta(output);
    }
    throw err;
  }
}

/** Persist metadata atomically. */
export async function saveMeta(layout: OutputLayout, meta: OutputMeta): Promise<void> {
  await writeFileAtomic(layout.metaPath, JSON.stringify(meta, null, 2));
}
