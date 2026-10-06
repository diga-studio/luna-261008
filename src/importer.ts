import { parseCsv } from './csv.ts';
import { normalizeKeyText } from './normalize.ts';
import { parseRfc3339ToUtcMs } from './timestamp.ts';
import type { ReviewStore, StoredRecord } from './store.ts';
import type { ImportResult, RecordError } from './types.ts';

/** 错误率上限：恰好 15% 允许，超过则整批拒绝。 */
const MAX_ERROR_PERCENT = 15;

/**
 * 导入一批 CSV 字节流。
 * 整批失败（结构性错误）或拒绝（错误率超限）时不修改任何已有数据。
 */
export function importCsv(store: ReviewStore, merchantId: string, bytes: Uint8Array): ImportResult {
  const parsed = parseCsv(bytes);
  if (!parsed.ok) {
    return {
      status: 'failed',
      totalRecords: 0,
      errorRecords: 0,
      imported: 0,
      errors: [],
      failureReason: parsed.reason,
    };
  }

  const records = parsed.records;
  const totalRecords = records.length;
  if (totalRecords === 0) {
    // 只有表头：空批次，成功但不修改数据
    return { status: 'ok', totalRecords: 0, errorRecords: 0, imported: 0, errors: [] };
  }

  const errors: RecordError[] = [];
  const valid: StoredRecord[] = [];

  for (const record of records) {
    const fail = (reason: string): void => {
      errors.push({ recordIndex: record.index, reason });
    };
    if (record.fields.length !== 4) {
      fail(`expected 4 fields, got ${record.fields.length}`);
      continue;
    }
    const [channel, reviewerName, text, timestamp] = record.fields;
    const timestampMs = parseRfc3339ToUtcMs(timestamp);
    if (timestampMs === null) {
      fail(`invalid timestamp: ${JSON.stringify(timestamp)}`);
      continue;
    }
    const normChannel = normalizeKeyText(channel);
    const normReviewerName = normalizeKeyText(reviewerName);
    if (normChannel === '' || normReviewerName === '') {
      fail('channel or reviewer_name is empty after normalization');
      continue;
    }
    valid.push({
      merchantId,
      normChannel,
      normReviewerName,
      timestampMs,
      channel,
      reviewerName,
      text,
      timestamp,
    });
  }

  const errorRecords = errors.length;
  // 恰好 15% 允许提交；超过 15% 整批拒绝（用整数比较避免浮点误差）
  if (errorRecords * 100 > totalRecords * MAX_ERROR_PERCENT) {
    return {
      status: 'rejected',
      totalRecords,
      errorRecords,
      imported: 0,
      errors,
      failureReason: `error rate ${errorRecords}/${totalRecords} exceeds 15%`,
    };
  }

  // 批内去重：相同键只保留最后一条有效记录
  const byKey = new Map<string, StoredRecord>();
  for (const stored of valid) {
    const key = JSON.stringify([stored.normChannel, stored.normReviewerName, stored.timestampMs]);
    byKey.set(key, stored);
  }
  const batch = [...byKey.values()];
  store.replaceBatch(batch);

  return { status: 'ok', totalRecords, errorRecords, imported: batch.length, errors };
}
