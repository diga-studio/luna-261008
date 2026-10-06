import type { ImportResult, RecordError, ValidRecord } from './types.js';
import { CsvParseError, parseCsvStream } from './csvParser.js';
import { validateRecord } from './validate.js';
import type { ReviewStore } from './store.js';

/**
 * 导入一批评论：解析 -> 校验 -> 错误率判定 -> 事务提交。
 * 任何整批失败/拒绝都不修改已有数据。
 */
export async function importReviews(
  store: ReviewStore,
  merchantId: string,
  stream: AsyncIterable<Uint8Array>,
): Promise<ImportResult> {
  let records;
  try {
    records = await parseCsvStream(stream);
  } catch (err) {
    if (err instanceof CsvParseError) {
      return {
        status: 'failed',
        totalRecords: 0,
        errorRecords: 0,
        errors: [],
        upserted: 0,
        fatalError: err.message,
      };
    }
    throw err;
  }

  const valid: ValidRecord[] = [];
  const errors: RecordError[] = [];
  for (const record of records) {
    const result = validateRecord(record);
    if (typeof result === 'string') {
      errors.push({ recordIndex: record.recordIndex, reason: result });
    } else {
      valid.push(result);
    }
  }

  const totalRecords = records.length;
  const errorRecords = errors.length;

  // 只有表头的文件视为空批次：成功但不修改数据
  if (totalRecords === 0) {
    return { status: 'imported', totalRecords, errorRecords, errors, upserted: 0 };
  }

  // 错误率 > 15% 整批拒绝（恰好 15% 允许提交）。用整数比较避免浮点误差。
  if (errorRecords * 20 > totalRecords * 3) {
    return { status: 'rejected', totalRecords, errorRecords, errors, upserted: 0 };
  }

  // 事务提交：相同键只保留批次中最后一条有效记录（按顺序覆盖），并替换库中已有记录
  store.upsertBatch(merchantId, valid);
  return { status: 'imported', totalRecords, errorRecords, errors, upserted: valid.length };
}
