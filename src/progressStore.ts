import { readJsonFile, writeJsonFile } from "./jsonFile.js";
import type { SyncProgress } from "./types.js";

function initialProgress(): SyncProgress {
  return {
    watermark: 0,
    round: 0,
    roundActive: false,
    roundBase: 0,
    roundUpperBound: 0,
    totalBatches: 0,
    nextBatchIndex: 0,
    pendingBatchId: null,
  };
}

/** Persistent sync progress (watermark + current round state). */
export class ProgressStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): SyncProgress {
    return readJsonFile<SyncProgress>(this.filePath, initialProgress);
  }

  save(progress: SyncProgress): void {
    writeJsonFile(this.filePath, progress);
  }
}
