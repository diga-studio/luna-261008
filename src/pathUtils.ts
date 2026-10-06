/**
 * Splits a normalized absolute path into its components
 * ("/a/b" -> ["a", "b"], "/" -> []).
 */
export function splitComponents(absolutePath: string): string[] {
  if (absolutePath === "/") {
    return [];
  }
  return absolutePath.slice(1).split("/");
}

/** Joins a child name onto an absolute path. */
export function joinPath(parentAbsolutePath: string, childName: string): string {
  return parentAbsolutePath === "/"
    ? "/" + childName
    : parentAbsolutePath + "/" + childName;
}

/**
 * Compares two strings by UTF-8 byte order.
 * Returns a negative number, zero, or a positive number.
 */
export function compareUtf8(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
