export interface CourseModule {
  /** Module title, preserved verbatim in the manifest. */
  title: string;
  /**
   * Entry HTML path relative to the snapshot source directory.
   * Case-sensitive; may contain non-ASCII characters, spaces and '%'.
   */
  entry: string;
}

export interface CourseSnapshot {
  title: string;
  modules: CourseModule[];
}

export interface PackedFile {
  /** Path inside the package (ASCII, e.g. "res/0001.html" or "imsmanifest.xml"). */
  packagePath: string;
  /** Source-relative path this file came from, or null for generated files. */
  sourcePath: string | null;
  data: Buffer;
}

export interface ScoDeclaration {
  moduleIndex: number;
  itemIdentifier: string;
  resourceIdentifier: string;
  /** Package path of the module entry HTML. */
  entryPackagePath: string;
  /** Package paths of the exact reachable closure for this entry. */
  files: string[];
}

export interface PackResult {
  /** All package files including imsmanifest.xml, in deterministic order. */
  files: PackedFile[];
  /** The generated imsmanifest.xml content. */
  manifest: string;
  scos: ScoDeclaration[];
  /** Maps source-relative path -> package path for every packed source file. */
  pathMap: ReadonlyMap<string, string>;
}
