import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { PersistedState } from "./types";

export class StateStore {
  constructor(private readonly filePath: string) {}

  exists(): boolean {
    return existsSync(this.filePath);
  }

  load(): PersistedState {
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (
      typeof parsed.crlNumber !== "number" ||
      !Array.isArray(parsed.certificates)
    ) {
      throw new Error(`corrupt state file: ${this.filePath}`);
    }
    return parsed;
  }

  save(state: PersistedState): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmpPath, this.filePath);
  }
}
