declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: () => void): void;
  export function afterEach(fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => void, check?: ((err: unknown) => boolean) | RegExp, message?: string): void;
  export function rejects(fn: () => Promise<unknown>, check?: ((err: unknown) => boolean) | RegExp, message?: string): Promise<void>;
  export function match(value: string, pattern: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    rejects: typeof rejects;
    match: typeof match;
  };
  export default assert;
}

declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:worker_threads' {
  import { EventEmitter } from 'node:events';
  export const parentPort: { postMessage(value: unknown): void } | null;
  export const workerData: unknown;
  export class Worker extends EventEmitter {
    constructor(filename: string | URL, options?: { workerData?: unknown });
    on(event: 'message', listener: (value: unknown) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'exit', listener: (code: number) => void): this;
  }
}

declare module 'node:events' {
  export class EventEmitter {
    on(event: string, listener: (...args: never[]) => void): this;
  }
}
