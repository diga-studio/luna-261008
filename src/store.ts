import * as fs from "node:fs";
import * as path from "node:path";

/** 基于本地 JSON 文件的持久化：写入采用临时文件 + 原子重命名。 */
export class JsonFileStore<T> {
  private readonly filePath: string;
  private readonly defaults: () => T;

  constructor(filePath: string, defaults: () => T) {
    this.filePath = filePath;
    this.defaults = defaults;
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  load(): T {
    if (!fs.existsSync(this.filePath)) {
      return this.defaults();
    }
    const raw = fs.readFileSync(this.filePath, "utf8");
    return JSON.parse(raw) as T;
  }

  save(state: T): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
