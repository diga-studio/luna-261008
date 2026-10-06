import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Clock,
  CreateTokenResult,
  ReadResult,
  SubmitResult,
  VaultOptions,
} from "./types.js";
import { VaultError } from "./types.js";
import { MetadataStore } from "./store.js";

export const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Recommendation letter intake vault. */
export class LetterVault {
  private readonly store: MetadataStore;
  private readonly storageDir: string;
  private readonly clock: Clock;

  constructor(options: VaultOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.storageDir = options.storageDir;
    this.store = new MetadataStore(options.dbPath);
  }

  close(): void {
    this.store.close();
  }

  async createToken(applicationId: string): Promise<CreateTokenResult> {
    await mkdir(this.storageDir, { recursive: true });
    const createdAt = this.clock();
    const expiresAt = createdAt + TOKEN_TTL_MS;
    const token = randomUUID();
    this.store.insertToken({
      token,
      applicationId,
      status: "pending",
      createdAt,
      expiresAt,
      contentHash: null,
      fileName: null,
    });
    return { token, expiresAt };
  }

  async submit(
    token: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<SubmitResult> {
    const row = this.store.getToken(token);
    if (!row) {
      throw new VaultError("token_not_found", `unknown token: ${token}`);
    }

    // Fully receive the input into a temp file before any state decision.
    // A mid-stream failure leaves no trace and never consumes the token.
    await mkdir(this.storageDir, { recursive: true });
    const tmpPath = join(this.storageDir, `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        chunks.push(buf);
      }
      await writeFile(tmpPath, Buffer.concat(chunks));
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
    const contentHash = hash.digest("hex");

    if (row.status === "submitted") {
      // Idempotent retry: identical bytes succeed even past the original
      // expiry; different bytes are rejected without touching the letter.
      await rm(tmpPath, { force: true });
      if (contentHash === row.contentHash) {
        return { ok: true, stored: false };
      }
      throw new VaultError(
        "content_mismatch",
        "token already consumed by a different letter",
      );
    }

    // Expiry is judged only after the input has been fully received,
    // strictly before the expiry instant.
    if (this.clock() >= row.expiresAt) {
      await rm(tmpPath, { force: true });
      throw new VaultError("token_expired", "token expired before submission completed");
    }

    const fileName = `${token}.pdf`;
    await rename(tmpPath, join(this.storageDir, fileName));
    this.store.markSubmitted(token, contentHash, fileName);
    return { ok: true, stored: true };
  }

  async read(token: string): Promise<ReadResult> {
    const row = this.store.getToken(token);
    if (!row) {
      throw new VaultError("token_not_found", `unknown token: ${token}`);
    }
    if (row.status === "submitted") {
      // A submitted letter never flips to "expired" as time passes.
      const stream = createReadStream(join(this.storageDir, row.fileName!));
      return { status: "submitted", stream };
    }
    return { status: this.clock() < row.expiresAt ? "pending" : "expired" };
  }
}
