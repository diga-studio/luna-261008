declare module "node:test" {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export = test;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp): void;
  };
  export = assert;
}

declare const process: {
  memoryUsage(): { heapUsed: number; rss: number; external: number };
  hrtime: { bigint(): bigint };
};

declare const global: { gc?: () => void };
