import type {
  RegisteredCertificate,
  RevocationServiceOptions,
  RevokeDepartmentResult,
} from "./types.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCrlPem,
  normalizeSerial,
  readCrlNumber,
  type CaMaterial,
  type RevokedEntry,
} from "./crl.ts";
import { StateStore, type State } from "./store.ts";

const STATE_FILE_NAME = "state.json";
const CRL_FILE_NAME = "crl.pem";

/** Atomically write the published CRL file (temp file + rename). */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

/** Sorted revoked entries derived from the current state. */
function revokedEntries(state: State): RevokedEntry[] {
  return Object.values(state.certificates)
    .filter((cert) => cert.revoked)
    .map((cert) => ({
      serialNumber: cert.serialNumber,
      revocationDate: new Date(cert.revokedAt as string),
    }))
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
}

/**
 * Certificate revocation publishing service.
 *
 * Persists state inside the caller-provided working directory and publishes
 * a PEM-encoded X.509v2 CRL file (`crl.pem`) there for the gateway to read.
 */
export class RevocationService {
  private readonly store: StateStore;
  private readonly crlFilePath: string;
  private readonly ca: CaMaterial;
  private state: State;
  private currentCrlPem: string;

  private constructor(
    store: StateStore,
    crlFilePath: string,
    ca: CaMaterial,
    state: State,
    currentCrlPem: string,
  ) {
    this.store = store;
    this.crlFilePath = crlFilePath;
    this.ca = ca;
    this.state = state;
    this.currentCrlPem = currentCrlPem;
  }

  /**
   * Open the service on a working directory. On first initialization an
   * empty CRL with number 0 is published.
   */
  static async open(options: RevocationServiceOptions): Promise<RevocationService> {
    mkdirSync(options.workDir, { recursive: true });
    const store = new StateStore(join(options.workDir, STATE_FILE_NAME));
    const crlFilePath = join(options.workDir, CRL_FILE_NAME);
    const ca: CaMaterial = {
      certificatePem: options.caCertificatePem,
      privateKeyPem: options.caPrivateKeyPem,
    };

    let state = store.load();
    if (state === null) {
      // First initialization: publish an empty CRL numbered 0.
      state = { crlNumber: 0, certificates: {} };
      const pem = await buildCrlPem(ca, 0, []);
      store.save(state);
      writeFileAtomic(crlFilePath, pem);
      return new RevocationService(store, crlFilePath, ca, state, pem);
    }

    // Reopened directory: trust the published file only when it matches the
    // persisted state; otherwise republish from the state (crash recovery).
    let pem: string | null = null;
    if (existsSync(crlFilePath)) {
      const onDisk = readFileSync(crlFilePath, "utf8");
      try {
        if (readCrlNumber(onDisk) === state.crlNumber) {
          pem = onDisk;
        }
      } catch {
        pem = null;
      }
    }
    if (pem === null) {
      pem = await buildCrlPem(ca, state.crlNumber, revokedEntries(state));
      writeFileAtomic(crlFilePath, pem);
    }
    return new RevocationService(store, crlFilePath, ca, state, pem);
  }

  /**
   * Register an issued client certificate. Re-registering the same serial
   * number is a no-op and never changes an existing revocation state.
   */
  async registerCertificate(cert: RegisteredCertificate): Promise<void> {
    const serialNumber = normalizeSerial(cert.serialNumber);
    if (this.state.certificates[serialNumber] !== undefined) {
      return;
    }
    this.state.certificates[serialNumber] = {
      serialNumber,
      department: cert.department,
      revoked: false,
    };
    this.store.save(this.state);
  }

  /**
   * Revoke every certificate of the department registered before this call.
   * Publishes a new CRL (number + 1) only when at least one certificate is
   * newly revoked; otherwise the published file and number stay unchanged.
   */
  async revokeDepartment(department: string): Promise<RevokeDepartmentResult> {
    const now = new Date();
    const batch = Object.values(this.state.certificates).filter(
      (cert) => cert.department === department && !cert.revoked,
    );
    if (batch.length === 0) {
      return { newlyRevoked: 0, crlNumber: this.state.crlNumber };
    }
    for (const cert of batch) {
      this.state.certificates[cert.serialNumber] = {
        ...cert,
        revoked: true,
        revokedAt: now.toISOString(),
      };
    }
    this.state.crlNumber += 1;
    const pem = await buildCrlPem(this.ca, this.state.crlNumber, revokedEntries(this.state));
    this.store.save(this.state);
    writeFileAtomic(this.crlFilePath, pem);
    this.currentCrlPem = pem;
    return { newlyRevoked: batch.length, crlNumber: this.state.crlNumber };
  }

  /** Return the PEM of the currently published CRL (matches the file). */
  async getCurrentCrl(): Promise<string> {
    return this.currentCrlPem;
  }
}
