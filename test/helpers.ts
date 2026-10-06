import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary directory tree that cleans itself up. */
export class Fixture {
  readonly root: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "scan-plan-"));
  }

  dir(relativePath: string): string {
    const absolute = join(this.root, relativePath);
    mkdirSync(absolute, { recursive: true });
    return absolute;
  }

  file(relativePath: string, content = "x"): string {
    const absolute = join(this.root, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
    return absolute;
  }

  hardLink(existingRelative: string, newRelative: string): string {
    const absolute = join(this.root, newRelative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    linkSync(join(this.root, existingRelative), absolute);
    return absolute;
  }

  symlink(target: string, newRelative: string): string {
    const absolute = join(this.root, newRelative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    symlinkSync(target, absolute);
    return absolute;
  }

  path(relativePath: string): string {
    return join(this.root, relativePath);
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
