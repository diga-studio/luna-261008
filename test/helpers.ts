import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageInput } from "../src/index.js";

/** A manually opened gate: trainers await it, tests open it. */
export class Gate {
  private readonly promise: Promise<void>;
  private release!: () => void;
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  wait(): Promise<void> {
    return this.promise;
  }
  open(): void {
    this.release();
  }
}

/** A signal that resolves when `open()` is called (same as Gate, one-shot). */
export class Signal {
  private readonly promise: Promise<void>;
  private fire!: () => void;
  private fired = false;
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.fire = resolve;
    });
  }
  wait(): Promise<void> {
    return this.promise;
  }
  open(): void {
    if (!this.fired) {
      this.fired = true;
      this.fire();
    }
  }
}

/** Flush the microtask queue and one macrotask cycle, deterministically. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function makeImages(
  count: number,
  scoreOf: (id: number) => number,
): ImageInput[] {
  return Array.from({ length: count }, (_, i) => {
    const id = i + 1;
    return { id, features: [id], score: scoreOf(id) };
  });
}

export function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "alq-test-"));
  return {
    path: join(dir, "queue.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
