// Minimal type shims so the project compiles without @types/node.
// Only the surface used by the tests is declared.
declare function setImmediate(callback: () => void): void;

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function test(fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function rejects(promise: Promise<unknown>, message?: string): Promise<void>;
  export function throws(fn: () => unknown, message?: string): void;
}
