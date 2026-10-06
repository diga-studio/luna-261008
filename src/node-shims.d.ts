// 最小 Node.js 类型声明，避免依赖 @types/node。
declare const Buffer: {
  from(data: string, encoding: "base64"): { length: number };
};

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:crypto" {
  export function randomBytes(size: number): { toString(encoding: "base64"): string };
}
declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
  }
  const test: Test;
  export = test;
}
