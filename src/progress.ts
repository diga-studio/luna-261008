import { ProgressState, ProgressStore } from "./types";
import * as fs from "node:fs";
import * as path from "node:path";

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** 基于本地 JSON 文件的同步进度存储。 */
export class FileProgressStore implements ProgressStore {
  private readonly file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "progress.json");
  }

  load(): ProgressState {
    if (!fs.existsSync(this.file)) {
      return { highWater: 0, round: null };
    }
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as ProgressState;
    return {
      highWater: parsed.highWater ?? 0,
      round: parsed.round ?? null,
    };
  }

  save(state: ProgressState): void {
    writeJsonAtomic(this.file, state);
  }
}
