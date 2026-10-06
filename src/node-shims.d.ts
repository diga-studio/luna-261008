// Minimal ambient declarations for the Node.js built-ins used by this
// project, so the repo compiles without @types/node.

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    run(...params: Array<string | number | bigint | null>): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    get(...params: Array<string | number | bigint | null>): unknown;
    all(...params: Array<string | number | bigint | null>): unknown[];
  }
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare function setImmediate(callback: () => void): unknown;
