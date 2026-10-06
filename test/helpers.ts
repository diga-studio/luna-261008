import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
  root: string;
  cleanup: () => void;
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "scan-plan-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function dir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function file(path: string, content = "x"): void {
  writeFileSync(path, content);
}

export function symlink(target: string, path: string): void {
  symlinkSync(target, path);
}

export function hardlink(target: string, path: string): void {
  linkSync(target, path);
}
