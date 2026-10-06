// Minimal ambient declarations for the Node built-ins used by the tests.
// Keeps the project self-contained: only the `typescript` devDependency is
// required, no @types/node download needed.
declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  const assert: {
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown): void;
  };
  export default assert;
}
