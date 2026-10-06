export interface TestCase {
  readonly name: string;
  readonly fn: () => void | Promise<void>;
}

const tests: TestCase[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

export async function runAll(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      process.stdout.write(`ok - ${t.name}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL - ${t.name}\n`);
      console.error(err);
    }
  }
  process.stdout.write(`${tests.length - failed}/${tests.length} tests passed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}
