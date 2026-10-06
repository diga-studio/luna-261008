import type { CourseSnapshot, PackResult } from "./types.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeClosures } from "./graph.ts";
import { createPathAssigner } from "./layout.ts";
import { generateManifest } from "./manifest.ts";
import { createZip } from "./zip.ts";

/**
 * Builds the full SCORM 1.2 package for a course snapshot whose source
 * files live under `sourceDir`. Returns every package file (resources
 * plus imsmanifest.xml) together with the per-SCO declarations.
 */
export function buildPackage(snapshot: CourseSnapshot, sourceDir: string): PackResult {
  const read = (sourcePath: string): Buffer | null => {
    try {
      return readFileSync(join(sourceDir, ...sourcePath.split("/")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
      throw error;
    }
  };
  const closures = computeClosures(snapshot, read, createPathAssigner());
  const scos = snapshot.modules.map((_, index) => {
    const suffix = String(index + 1).padStart(4, "0");
    return {
      moduleIndex: index,
      itemIdentifier: `ITEM-${suffix}`,
      resourceIdentifier: `RES-${suffix}`,
      entryPackagePath: closures.pathMap.get(snapshot.modules[index].entry) as string,
      files: closures.perModule[index].map(
        (sourcePath) => closures.pathMap.get(sourcePath) as string,
      ),
    };
  });
  const manifest = generateManifest(snapshot, scos);
  const files = closures.reachable.map((sourcePath) => {
    const rewritten = closures.rewrittenHtml.get(sourcePath);
    const data =
      rewritten !== undefined
        ? Buffer.from(rewritten, "utf8")
        : (closures.contents.get(sourcePath) as Buffer);
    return {
      packagePath: closures.pathMap.get(sourcePath) as string,
      sourcePath,
      data,
    };
  });
  files.push({
    packagePath: "imsmanifest.xml",
    sourcePath: null,
    data: Buffer.from(manifest, "utf8"),
  });
  return { files, manifest, scos, pathMap: closures.pathMap };
}

/**
 * Builds the package and writes it as a ZIP archive to `outFile`.
 */
export function exportZip(snapshot: CourseSnapshot, sourceDir: string, outFile: string): void {
  const result = buildPackage(snapshot, sourceDir);
  const zip = createZip(
    result.files.map((file) => ({ name: file.packagePath, data: file.data })),
  );
  writeFileSync(outFile, zip);
}
