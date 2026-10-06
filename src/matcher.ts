import { editDistance } from "./editDistance.js";
import type { CriminalRecord, Employee, MatchCategory } from "./types.js";

/** 归一化 SSN：空值视为缺失；仅接受 9 位或 4 位数字串 */
function normalizeSsn(ssn: string | undefined): string | undefined {
  if (ssn === undefined || ssn === "") return undefined;
  if (!/^\d{4}$/.test(ssn) && !/^\d{9}$/.test(ssn)) {
    throw new Error(`invalid ssn format: ${JSON.stringify(ssn)}`);
  }
  return ssn;
}

/** 双方 SSN 已知的对应位（按右对齐比较）是否存在差异 */
function ssnConflicts(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const width = Math.min(a.length, b.length);
  return a.slice(-width) !== b.slice(-width);
}

/** 双方都有出生日期且不同 */
function birthDateConflicts(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a !== b;
}

/**
 * 判定单个 (员工, 刑录) 配对的命中类别。
 * 先排除身份冲突；再按 exact > partial > fuzzy 分类，均不满足返回 null。
 */
export function classifyPair(
  employee: Employee,
  record: CriminalRecord,
): MatchCategory | null {
  const empSsn = normalizeSsn(employee.ssn);
  const recSsn = normalizeSsn(record.ssn);

  if (birthDateConflicts(employee.birthDate, record.birthDate)) return null;
  if (ssnConflicts(empSsn, recSsn)) return null;

  if (empSsn !== undefined && empSsn.length === 9 && empSsn === recSsn) {
    return "exact";
  }

  const sameBirthDate =
    employee.birthDate !== undefined && employee.birthDate === record.birthDate;
  if (!sameBirthDate) return null;

  if (employee.nameKey === record.nameKey) return "partial";
  if (editDistance(employee.nameKey, record.nameKey, 2) <= 2) return "fuzzy";
  return null;
}
