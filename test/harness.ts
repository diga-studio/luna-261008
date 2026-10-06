export type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export async function runAll(): Promise<void> {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok - ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL - ${name}\n`);
      process.stdout.write(`  ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    }
  }
  process.stdout.write(`${tests.length - failed}/${tests.length} passed\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}
