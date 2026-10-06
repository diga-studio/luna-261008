/**
 * Minimal type declarations for the Node.js built-in test runner and assert.
 * Keeps the project self-contained: only the `typescript` devDependency is
 * required, so `npm install && npm test` works on a clean Node.js machine.
 */
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
}
