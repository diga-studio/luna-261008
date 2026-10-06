// 本工程只依赖 Node.js 内置模块。为保证在仅安装 typescript 的干净机器上
// 即可通过类型检查，这里声明用到的最小 Node API 表面，不依赖 @types/node。

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function renameSync(oldPath: string, newPath: string): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function strictEqual(
    actual: unknown,
    expected: unknown,
    message?: string,
  ): void;
  export function deepStrictEqual(
    actual: unknown,
    expected: unknown,
    message?: string,
  ): void;
  export function throws(fn: () => void, message?: string): void;
}
