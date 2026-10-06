export interface Clock {
    now(): number;
}
export declare class SystemClock implements Clock {
    now(): number;
}
export declare class ManualClock implements Clock {
    private current;
    constructor(start?: number);
    now(): number;
    advance(ms: number): void;
}
