// 最小化的 Node 内置模块类型声明，避免依赖 @types/node。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  const testFn: typeof test;
  export default testFn;
}
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    fail: typeof fail;
  };
  export default assert;
}
