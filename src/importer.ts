import { parseCsv } from './csvParser.js';
import { BillingStore } from './store.js';
import { validateRow } from './validate.js';
import {
  ImportFileError,
  type BillingRecord,
  type ImportResult,
  type RowError,
} from './types.js';

export const MAX_RECORD_BYTES = 64 * 1024;

const HEADER_FIELDS = [
  'resource_id',
  'usage_date',
  'usage_quantity',
  'unit_cost',
  'total_cost',
];

/**
 * CostLens streaming billing importer. Calls are executed serially by the
 * caller; each import runs inside one SQLite transaction so a failed import
 * never changes committed data.
 */
export class CostLens {
  private readonly store: BillingStore;

  constructor(dbPath: string) {
    this.store = new BillingStore(dbPath);
  }

  async importBilling(
    accountId: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<ImportResult> {
    const errors: RowError[] = [];
    let imported = 0;
    let sawHeader = false;
    this.store.beginImport();
    try {
      for await (const record of parseCsv(chunks, MAX_RECORD_BYTES)) {
        if (!sawHeader) {
          sawHeader = true;
          if (
            record.fields.length !== HEADER_FIELDS.length ||
            !HEADER_FIELDS.every((name, i) => record.fields[i] === name)
          ) {
            throw new ImportFileError(
              'INVALID_HEADER',
              'header must be exactly: ' + HEADER_FIELDS.join(','),
            );
          }
          continue;
        }
        const rowNumber = record.recordNumber - 1;
        const validation = validateRow(record.fields);
        if (validation.keyValid && validation.key) {
          const key = { accountId, ...validation.key };
          if (this.store.hasKey(key)) {
            errors.push({ row: rowNumber, code: 'DUPLICATE_KEY' });
          } else {
            this.store.addBatchKey(key);
            if (validation.errors.length === 0) {
              const [resourceId, usageDate, usageQuantity, unitCost, totalCost] =
                record.fields as [string, string, string, string, string];
              this.store.insertBilling(key, {
                resourceId,
                usageDate,
                usageQuantity,
                unitCost,
                totalCost,
              });
              imported += 1;
            }
          }
        }
        for (const code of validation.errors) {
          errors.push({ row: rowNumber, code });
        }
      }
    } catch (err) {
      this.store.rollbackImport();
      throw err;
    }
    if (!sawHeader) {
      this.store.rollbackImport();
      throw new ImportFileError('INVALID_HEADER', 'input is empty; header record missing');
    }
    if (errors.length > 0) {
      this.store.rollbackImport();
      return { ok: false, errors };
    }
    this.store.commitImport();
    return { ok: true, imported };
  }

  readBilling(accountId: string): AsyncIterable<BillingRecord> {
    return this.store.readBilling(accountId);
  }

  close(): void {
    this.store.close();
  }
}
