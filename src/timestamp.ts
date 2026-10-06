const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 校验带时区的 RFC3339 时间（最多 3 位小数，秒不为 60，日期真实存在）。
 * 合法时返回 UTC 毫秒，否则返回 null。
 */
export function parseRfc3339ToUtcMs(value: string): number | null {
  const m = RFC3339.exec(value);
  if (!m) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const frac = m[7];
  const zone = m[8];

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  // 日期必须真实存在（如 2 月 30 日不合法）
  const dateMs = Date.UTC(year, month - 1, day);
  const check = new Date(dateMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  let offsetMs = 0;
  if (zone !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) {
      return null;
    }
    offsetMs = (oh * 60 + om) * 60 * 1000;
    if (zone[0] === '-') {
      offsetMs = -offsetMs;
    }
  }

  let fracMs = 0;
  if (frac) {
    const digits = frac.slice(1);
    fracMs = Number(digits) * (digits.length === 1 ? 100 : digits.length === 2 ? 10 : 1);
  }

  return dateMs + ((hour * 60 + minute) * 60 + second) * 1000 + fracMs - offsetMs;
}
