import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { buildCrlPem, type CrlEntry } from "./crl";
import { StateStore } from "./store";
import type {
  CertificateRecord,
  PersistedState,
  RevokeDepartmentResult,
} from "./types";

export interface RevocationServiceOptions {
  readonly workDir: string;
  readonly caCertPem: string;
  readonly caKeyPem: string;
  readonly crlFileName?: string;
  readonly nextUpdateIntervalMs?: number;
}

const DEFAULT_CRL_FILE_NAME = "crl.pem";
const DEFAULT_NEXT_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeSerialNumber(serialNumber: string): string {
  const hex = serialNumber.trim().toLowerCase().replace(/^0x/, "");
  if (hex.length === 0 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`invalid certificate serial number: ${serialNumber}`);
  }
  return hex;
}

export class RevocationService {
  private readonly caCertPem: string;
  private readonly caKeyPem: string;
  private readonly crlPath: string;
  private readonly nextUpdateIntervalMs: number;
  private readonly store: StateStore;
  private state: PersistedState;

  constructor(options: RevocationServiceOptions) {
    this.caCertPem = options.caCertPem;
    this.caKeyPem = options.caKeyPem;
    this.crlPath = join(
      options.workDir,
      options.crlFileName ?? DEFAULT_CRL_FILE_NAME
    );
    this.nextUpdateIntervalMs =
      options.nextUpdateIntervalMs ?? DEFAULT_NEXT_UPDATE_INTERVAL_MS;

    mkdirSync(options.workDir, { recursive: true });
    this.store = new StateStore(join(options.workDir, "state.json"));
    if (this.store.exists()) {
      this.state = this.store.load();
    } else {
      this.state = { crlNumber: 0, certificates: [] };
      this.store.save(this.state);
      this.publishCrl();
    }
    if (!existsSync(this.crlPath)) {
      this.publishCrl();
    }
  }

  registerCertificate(serialNumber: string, department: string): CertificateRecord {
    const serial = normalizeSerialNumber(serialNumber);
    if (department.trim().length === 0) {
      throw new Error("department must not be empty");
    }
    const existing = this.state.certificates.find(
      (cert) => cert.serialNumber === serial
    );
    if (existing) {
      return existing;
    }
    const record: CertificateRecord = {
      serialNumber: serial,
      department,
      revoked: false,
    };
    this.state = {
      ...this.state,
      certificates: [...this.state.certificates, record],
    };
    this.store.save(this.state);
    return record;
  }

  revokeDepartment(department: string): RevokeDepartmentResult {
    const now = new Date();
    const targets = this.state.certificates.filter(
      (cert) => cert.department === department && !cert.revoked
    );
    if (targets.length === 0) {
      return {
        department,
        newlyRevoked: [],
        crlNumber: this.state.crlNumber,
        published: false,
      };
    }
    const revocationDate = now.toISOString();
    const certificates = this.state.certificates.map((cert) =>
      cert.department === department && !cert.revoked
        ? { ...cert, revoked: true, revocationDate }
        : cert
    );
    this.state = {
      crlNumber: this.state.crlNumber + 1,
      certificates,
    };
    this.store.save(this.state);
    this.publishCrl();
    return {
      department,
      newlyRevoked: targets.map((cert) => cert.serialNumber),
      crlNumber: this.state.crlNumber,
      published: true,
    };
  }

  getCurrentCrl(): string {
    return readFileSync(this.crlPath, "utf8");
  }

  private publishCrl(): void {
    const now = new Date();
    const entries: CrlEntry[] = this.state.certificates
      .filter((cert) => cert.revoked)
      .map((cert) => ({
        serialNumber: cert.serialNumber,
        revocationDate: new Date(cert.revocationDate as string),
      }));
    const pem = buildCrlPem(
      this.caCertPem,
      this.caKeyPem,
      this.state.crlNumber,
      entries,
      now,
      new Date(now.getTime() + this.nextUpdateIntervalMs)
    );
    const tmpPath = `${this.crlPath}.tmp`;
    writeFileSync(tmpPath, pem, "utf8");
    renameSync(tmpPath, this.crlPath);
  }
}
