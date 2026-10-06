import type { RawRecord, ValidRecord } from './types.js';

const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 解析带时区的 RFC3339 时间，归一为 UTC 毫秒。
 * 最多 3 位小数，秒不能为 60，日期必须真实存在；未带时区不合法。
 * 不合法时返回 null。
 */
export function parseTimestamp(value: string): number | null {
  const m = RFC3339_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const frac = m[7];
  const offset = m[8];

  if (month < 1 || month > 12) return null;
  const maxDay =
    month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) return null;
  if (hour > 23 || minute > 59 || second > 59) return null; // 秒不能为 60

  let millis = 0;
  if (frac) {
    // frac 形如 ".5" / ".05" / ".005"，最多 3 位（正则已保证）
    millis = Number(frac.slice(1).padEnd(3, '0'));
  }

  let offsetMinutes = 0;
  if (offset !== 'Z') {
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = oh * 60 + om;
    if (offset[0] === '-') offsetMinutes = -offsetMinutes;
  }

  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
}

/** 去掉首尾 ASCII 空格，再做 Unicode NFC 归一（区分大小写）。 */
export function normalizeKeyPart(value: string): string {
  return value.replace(/^ +| +$/g, '').normalize('NFC');
}

/**
 * 校验一条原始记录并归一化。
 * 返回 ValidRecord，或返回错误原因字符串（记录级错误，可继续处理）。
 */
export function validateRecord(record: RawRecord): ValidRecord | string {
  const { fields } = record;
  if (fields.length !== 4) {
    return `expected 4 fields, got ${fields.length}`;
  }
  const [channel, reviewerName, text, timestamp] = fields;

  const normChannel = normalizeKeyPart(channel);
  if (normChannel.length === 0) return 'channel is empty after normalization';
  const normReviewer = normalizeKeyPart(reviewerName);
  if (normReviewer.length === 0) return 'reviewer_name is empty after normalization';

  const timestampMs = parseTimestamp(timestamp);
  if (timestampMs === null) return `invalid timestamp: ${timestamp}`;

  return {
    raw: { channel, reviewerName, text, timestamp },
    key: { channel: normChannel, reviewerName: normReviewer, timestampMs },
  };
}
