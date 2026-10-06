export declare const STAGES: readonly ["Identified", "Contacted", "Engaged", "Submitted to Client", "Interviewing", "Placed", "Alumni"];
export type Stage = (typeof STAGES)[number];
export interface StageChange {
    readonly atMs: number;
    readonly stage: Stage;
}
export interface StageReportEntry {
    readonly stage: Stage;
    readonly segmentCount: number;
    readonly totalDurationMs: number;
    readonly averageDurationMs: number;
}
export interface StageReport {
    readonly asOfMs: number;
    readonly windowMs: number;
    readonly entries: readonly StageReportEntry[];
}
