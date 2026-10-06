/** 极简测试框架：注册 + 顺序执行 + 汇总退出码 */
export type TestFn = () => void | Promise<void>;

interface Case {
  name: string;
  fn: TestFn;
}

const cases: Case[] = [];

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

export async function run(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      process.stdout.write(`ok   ${c.name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL ${c.name}\n`);
      process.stderr.write(`${String(err)}\n`);
      if (err instanceof Error && err.stack) {
        process.stderr.write(`${err.stack}\n`);
      }
    }
  }
  process.stdout.write(`${cases.length - failed}/${cases.length} passed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}
