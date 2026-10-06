// 最小 Node.js 类型声明，避免为类型检查引入 @types/node 依赖。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
  export default assert;
}

declare const process: {
  memoryUsage(): { heapUsed: number };
};
