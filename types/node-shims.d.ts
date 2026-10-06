// Minimal ambient declarations for the Node.js built-ins used by this
// project, so the build does not depend on @types/node being installed.

declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:test' {
  export type TestContext = {
    name: string;
    diagnostic(message: string): void;
  };
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function rejects(fn: () => Promise<unknown>, matcher?: (err: unknown) => boolean, message?: string): Promise<unknown>;
  export function throws(fn: () => unknown, matcher?: (err: unknown) => boolean, message?: string): void;
}

declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare const process: {
  env: Record<string, string | undefined>;
};

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
