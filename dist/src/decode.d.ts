export interface ByteDecoder {
    write(bytes: Uint8Array): Uint8Array;
    finish(): Uint8Array;
}
export interface CharDecoder {
    write(bytes: Uint8Array): string;
    finish(): string;
}
export declare function createTransferDecoder(encoding: string): ByteDecoder;
export declare function createCharsetDecoder(charset: string): CharDecoder;
