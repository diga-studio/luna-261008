import { STAGES } from "./types.js";
import type { Stage, StageChange, StageReport, StageReportEntry } from "./types.js";

export const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function validateHistory(candidateId: string, changes: readonly StageChange[]): void {
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (!Number.isSafeInteger(change.atMs)) {
      throw new Error(
        `candidate ${candidateId}: change[${i}].atMs must be an integer millisecond timestamp`,
      );
    }
    if (!STAGES.includes(change.stage)) {
      throw new Error(`candidate ${candidateId}: change[${i}] has unknown stage "${change.stage}"`);
    }
    if (i > 0) {
      const prev = changes[i - 1];
      if (change.atMs <= prev.atMs) {
        throw new Error(
          `candidate ${candidateId}: change[${i}].atMs (${change.atMs}) must be strictly greater than previous (${prev.atMs})`,
        );
      }
      if (change.stage === prev.stage) {
        throw new Error(
          `candidate ${candidateId}: change[${i}] repeats the previous stage "${change.stage}"`,
        );
      }
    }
  }
}

export class TalentPipeline {
  private readonly histories = new Map<string, StageChange[]>();

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be a positive integer");
    }
  }

  submitHistory(candidateId: string, changes: readonly StageChange[]): void {
    if (this.histories.has(candidateId)) {
      throw new Error(`candidate ${candidateId} already has a history; use replaceHistory to correct it`);
    }
    validateHistory(candidateId, changes);
    this.histories.set(candidateId, changes.map((c) => ({ atMs: c.atMs, stage: c.stage })));
  }

  replaceHistory(candidateId: string, changes: readonly StageChange[]): void {
    validateHistory(candidateId, changes);
    if (changes.length === 0) {
      this.histories.delete(candidateId);
      return;
    }
    this.histories.set(candidateId, changes.map((c) => ({ atMs: c.atMs, stage: c.stage })));
  }

  removeCandidate(candidateId: string): void {
    this.histories.delete(candidateId);
  }

  report(asOfMs: number): StageReport {
    if (!Number.isSafeInteger(asOfMs)) {
      throw new Error("asOfMs must be an integer millisecond timestamp");
    }
    const windowStartMs = asOfMs - this.windowMs;
    const totals = new Map<Stage, { count: number; durationMs: number }>();
    for (const stage of STAGES) {
      totals.set(stage, { count: 0, durationMs: 0 });
    }

    for (const changes of this.histories.values()) {
      for (let i = 0; i < changes.length; i++) {
        const segStart = changes[i].atMs;
        const segEnd = i + 1 < changes.length ? changes[i + 1].atMs : Number.POSITIVE_INFINITY;
        const overlapStart = Math.max(segStart, windowStartMs);
        const overlapEnd = Math.min(segEnd, asOfMs);
        const overlapMs = overlapEnd - overlapStart;
        if (overlapMs > 0) {
          const bucket = totals.get(changes[i].stage)!;
          bucket.count += 1;
          bucket.durationMs += overlapMs;
        }
      }
    }

    const entries: StageReportEntry[] = STAGES.map((stage) => {
      const bucket = totals.get(stage)!;
      return {
        stage,
        segmentCount: bucket.count,
        totalDurationMs: bucket.durationMs,
        averageDurationMs: bucket.count === 0 ? 0 : bucket.durationMs / bucket.count,
      };
    });

    return { asOfMs, windowMs: this.windowMs, entries };
  }
}
