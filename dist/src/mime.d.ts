export interface MimeEvents {
    onLeafStart(): void;
    onLeafText(text: string): void;
    onLeafEnd(): void;
}
export declare class MimeParser {
    private events;
    private mode;
    private stack;
    private headerBuf;
    private atLineStart;
    private pending;
    private pendingCR;
    private heldCR;
    private heldCrlf;
    private sinkLeaf;
    private transferDecoder;
    private charsetDecoder;
    private bodyBatch;
    constructor(events: MimeEvents);
    write(bytes: Uint8Array): void;
    finish(): void;
    private feedByte;
    private feedHeaderByte;
    private endHeaders;
    private enterLinesMode;
    private feedLineByte;
    private feedDecidingByte;
    private isConsistent;
    private consistentWith;
    private matchDelimiter;
    private resolveLine;
    private resolveLineAtEof;
    private classify;
    private flushPendingAsBody;
    private handleDelimiter;
    private endLeafIfNeeded;
    private emitToBody;
    private flushBodyBatch;
}
