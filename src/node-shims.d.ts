// Minimal declarations for the Node built-ins used by the tests, so the
// project builds without @types/node (kept offline-install friendly).
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:test" {
  export function test(name: string, fn: () => void): void;
  export default test;
}
declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function fail(message?: string): never;
  export function throws(fn: () => unknown, message?: string): void;
}
