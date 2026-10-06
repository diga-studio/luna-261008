// 本库只依赖 Node.js 内置模块。为避免强制安装 @types/node，
// 这里声明测试用到的最小 API 面。

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
  export { test };
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare const process: {
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  hrtime: { bigint(): bigint };
};

declare const gc: (() => void) | undefined;

declare const console: {
  log(...args: unknown[]): void;
};
