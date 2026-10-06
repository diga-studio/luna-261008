import * as fs from "fs";
import * as path from "path";

/** 简单的本地 JSON 文件持久化工具：每个 key 对应 storageDir 下的一个 .json 文件。 */
export class JsonStore {
  private readonly dir: string;

  constructor(storageDir: string) {
    this.dir = storageDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileOf(key: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return path.join(this.dir, `${key}.json`);
  }

  has(key: string): boolean {
    return fs.existsSync(this.fileOf(key));
  }

  read<T>(key: string): T | undefined {
    const file = this.fileOf(key);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  }

  write<T>(key: string, value: T): void {
    const file = this.fileOf(key);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }
}
