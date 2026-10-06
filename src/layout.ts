/**
 * Assigns deterministic ASCII package paths ("res/0001.html", ...) that
 * are unique even under case-insensitive comparison. The file extension
 * is preserved when it is pure ASCII, otherwise dropped.
 */
export function createPathAssigner(): (sourcePath: string, isHtml: boolean) => string {
  const usedLowercase = new Set<string>();
  let counter = 0;
  return (_sourcePath: string, isHtml: boolean): string => {
    const ext = asciiExtension(_sourcePath) ?? (isHtml ? ".html" : "");
    let candidate: string;
    do {
      counter++;
      candidate = `res/${String(counter).padStart(4, "0")}${ext}`;
    } while (usedLowercase.has(candidate.toLowerCase()));
    usedLowercase.add(candidate.toLowerCase());
    return candidate;
  };
}

/** Returns a lowercased ASCII extension (".png") or null when non-ASCII. */
function asciiExtension(sourcePath: string): string | null {
  const slash = sourcePath.lastIndexOf("/");
  const dot = sourcePath.lastIndexOf(".");
  if (dot === -1 || dot < slash) return null;
  const ext = sourcePath.slice(dot);
  return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : null;
}
