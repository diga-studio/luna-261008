import { openDatabase } from "./db.js";
import { publishChallengeVersion, getCurrentChallenge } from "./challenge.js";
import { submitAnswers } from "./submission.js";
import { getProgress } from "./progress.js";
import type {
  CurrentChallenge,
  Progress,
  PublishInput,
  SubmitInput,
  SubmitResult,
} from "./types.js";

export * from "./types.js";

/** 结算库入口：由上层实例化并持有 */
export class OnboardingChallenge {
  private readonly db: import("node:sqlite").DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  publishChallengeVersion(input: PublishInput): number {
    return publishChallengeVersion(this.db, input);
  }

  getCurrentChallenge(): CurrentChallenge {
    return getCurrentChallenge(this.db);
  }

  submitAnswers(input: SubmitInput): SubmitResult {
    return submitAnswers(this.db, input);
  }

  getProgress(learnerId: string): Progress {
    return getProgress(this.db, learnerId);
  }

  close(): void {
    this.db.close();
  }
}
