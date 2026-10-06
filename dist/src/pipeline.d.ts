import type { StageChange, StageReport } from "./types.js";
export declare const DEFAULT_WINDOW_MS: number;
export declare class TalentPipeline {
    private readonly windowMs;
    private readonly histories;
    constructor(windowMs?: number);
    submitHistory(candidateId: string, changes: readonly StageChange[]): void;
    replaceHistory(candidateId: string, changes: readonly StageChange[]): void;
    removeCandidate(candidateId: string): void;
    report(asOfMs: number): StageReport;
}
