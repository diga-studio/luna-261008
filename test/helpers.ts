import { mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

let failures = 0;
let currentSuite = "";

export function suite(name: string): void {
  currentSuite = name;
  console.log(`\n== ${name}`);
}

export function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok - ${message}`);
  } else {
    failures++;
    console.error(`  FAIL - ${message}`);
  }
}

export function checkThrows(fn: () => void, message: string): void {
  try {
    fn();
  } catch {
    console.log(`  ok - ${message}`);
    return;
  }
  failures++;
  console.error(`  FAIL - ${message} (expected throw)`);
}

export function report(): void {
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

export function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "evidence-store-"));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Recursively list all files under dir, relative to dir, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (sub: string): void => {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) {
        walk(rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

export { join, relative };
