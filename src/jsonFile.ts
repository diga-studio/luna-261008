/** Atomic JSON file persistence helper (write tmp + rename, read with recovery). */
import * as fs from "node:fs";
import * as path from "node:path";

export function readJsonFile<T>(filePath: string, fallback: () => T): T {
  if (!fs.existsSync(filePath)) {
    return fallback();
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.length === 0) {
    return fallback();
  }
  return JSON.parse(raw) as T;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}
