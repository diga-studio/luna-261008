import type { Message } from "./types.js";
export declare class DnsParseError extends Error {
    constructor(message: string);
}
export declare function parseMessage(bytes: Uint8Array): Message;
