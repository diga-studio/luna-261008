export interface Rule {
    id: string;
    needle: string;
    weight: number;
}
export interface ScanResult {
    hitIds: string[];
    score: number;
    quarantined: boolean;
}
export interface Scanner {
    write(bytes: Uint8Array): string[];
    finish(): ScanResult;
}
