import { CsvParser } from "./csvParser.js";
import { FileImportError } from "./errors.js";
import { BillingStore } from "./store.js";
import type { BillingRecord, ImportResult, RowError } from "./types.js";
import { validateRow } from "./validate.js";

const EXPECTED_HEADER = ["resource_id", "usage_date", "usage_quantity", "unit_cost", "total_cost"];

/** Simple async mutex serializing all calls on a CostLens instance. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = this.tail.then(() => next);
    return prev.then(() => release);
  }
}

/** Strips an optional UTF-8 BOM that may be split across chunks. */
class BomStripper {
  private pending: number[] = [];
  private done = false;

  push(chunk: Uint8Array): Uint8Array | null {
    if (this.done) return chunk.length > 0 ? chunk : null;
    const merged = [...this.pending, ...chunk];
    if (merged.length < 3) {
      this.pending = merged;
      return null;
    }
    this.done = true;
    const bytes = Uint8Array.from(merged);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return bytes.subarray(3);
    }
    return bytes;
  }

  end(): Uint8Array | null {
    if (this.done || this.pending.length === 0) return null;
    this.done = true;
    return Uint8Array.from(this.pending);
  }
}

export class CostLens {
  private readonly store: BillingStore;
  private readonly mutex = new Mutex();

  constructor(dbPath: string) {
    this.store = new BillingStore(dbPath);
    this.store.open();
  }

  async close(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      this.store.close();
    } finally {
      release();
    }
  }

  /**
   * Import billing records from a chunked CSV byte stream.
   * Resolves with the imported count, or the full row-level error list
   * (nothing is committed in that case). Throws FileImportError for
   * file-level failures (also fully rolled back).
   */
  importBilling(accountId: string, chunks: AsyncIterable<Uint8Array>): Promise<ImportResult> {
    return this.serialized(() => this.doImport(accountId, chunks));
  }

  /** Stream committed billing records for an account in insertion order. */
  readBilling(accountId: string): AsyncIterable<BillingRecord> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const release = await self.mutex.acquire();
        try {
          yield* self.store.readAll(accountId);
        } finally {
          release();
        }
      },
    };
  }

  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async doImport(
    accountId: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<ImportResult> {
    const parser = new CsvParser();
    const bom = new BomStripper();
    const errors: RowError[] = [];
    let imported = 0;
    let line = 0;
    let headerChecked = false;

    this.store.begin();
    try {
      const handleRecord = (fields: string[]): void => {
        if (!headerChecked) {
          headerChecked = true;
          checkHeader(fields);
          return;
        }
        line++;
        const validation = validateRow(fields);
        const rowErrors = [...validation.errors];
        if (validation.keyValid) {
          const resourceId = fields[0]!;
          const usageDate = fields[1]!;
          const newInBatch = this.store.trackBatchKey(accountId, resourceId, usageDate);
          const committed = this.store.hasKey(accountId, resourceId, usageDate);
          if (!newInBatch || committed) rowErrors.push("DUPLICATE_KEY");
        }
        for (const code of rowErrors) errors.push({ line, code });
        if (rowErrors.length === 0 && validation.row !== null) {
          this.store.insert(accountId, validation.row);
          imported++;
        }
      };

      for await (const chunk of chunks) {
        const bytes = bom.push(chunk);
        if (bytes !== null) {
          for (const record of parser.push(bytes)) handleRecord(record);
        }
      }
      const tail = bom.end();
      if (tail !== null) {
        for (const record of parser.push(tail)) handleRecord(record);
      }
      for (const record of parser.end()) handleRecord(record);

      if (!headerChecked) {
        throw new FileImportError("HEADER_MISMATCH", "input is empty");
      }
    } catch (err) {
      this.store.rollback();
      if (err instanceof FileImportError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new FileImportError("STREAM_ERROR", message);
    }

    if (errors.length > 0) {
      this.store.rollback();
      return { status: "row_errors", errors };
    }
    this.store.commit();
    return { status: "ok", imported };
  }
}

function checkHeader(fields: string[]): void {
  if (fields.length !== EXPECTED_HEADER.length) {
    throw new FileImportError("HEADER_MISMATCH", "unexpected CSV header");
  }
  for (let i = 0; i < EXPECTED_HEADER.length; i++) {
    if (fields[i] !== EXPECTED_HEADER[i]) {
      throw new FileImportError("HEADER_MISMATCH", "unexpected CSV header");
    }
  }
}
