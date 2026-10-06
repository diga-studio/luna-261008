import { classifyPair } from "./matcher.js";
import type {
  CriminalRecord,
  Employee,
  EmployeeScreenResult,
  MatchCategory,
  ScreenHit,
} from "./types.js";

const CATEGORY_RANK: Record<MatchCategory, number> = {
  exact: 0,
  partial: 1,
  fuzzy: 2,
};

/**
 * 批量筛查：对每位员工返回全部命中刑录的标识及类别。
 * 同一配对只取最高类别；不同标识的刑录分别保留；
 * 筛查期间数据集固定（由调用方传入快照）。
 */
export function screenEmployees(
  employees: readonly Employee[],
  dataset: readonly CriminalRecord[],
): EmployeeScreenResult[] {
  return employees.map((employee) => {
    const hits: ScreenHit[] = [];
    for (const record of dataset) {
      const category = classifyPair(employee, record);
      if (category !== null) hits.push({ recordId: record.id, category });
    }
    hits.sort(
      (a, b) =>
        CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
        a.recordId.localeCompare(b.recordId),
    );
    return { employeeId: employee.id, hits };
  });
}
