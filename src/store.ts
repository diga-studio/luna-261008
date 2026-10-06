import type { RegisteredCertificate } from "./types.ts";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Internal record kept per registered certificate. */
export interface StoredCertificate extends RegisteredCertificate {
  /** Whether this certificate has been revoked. */
  readonly revoked: boolean;
  /** ISO-8601 time of revocation; present iff revoked. */
  readonly revokedAt?: string;
}

/** Persistent state of the revocation service. */
export interface State {
  /** CRL number of the CRL described by this state. */
  crlNumber: number;
  /** Registered certificates keyed by normalized serial number. */
  certificates: Record<string, StoredCertificate>;
}

/** File-based persistence of the service state inside the working directory. */
export class StateStore {
  private readonly stateFilePath: string;

  constructor(stateFilePath: string) {
    this.stateFilePath = stateFilePath;
  }

  /** Load state from disk, or null when no state file exists yet. */
  load(): State | null {
    if (!existsSync(this.stateFilePath)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(this.stateFilePath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.crlNumber !== "number" ||
      typeof parsed.certificates !== "object" ||
      parsed.certificates === null
    ) {
      throw new Error(`corrupt state file: ${this.stateFilePath}`);
    }
    return parsed as State;
  }

  /** Atomically persist the given state (write temp file, then rename). */
  save(state: State): void {
    const tmpPath = `${this.stateFilePath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmpPath, this.stateFilePath);
  }
}
