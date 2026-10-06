import type { DatasetStore } from "./store.js";
import { classifyPair } from "./matching.js";
import type { EmployeeScreeningResult, PersonInput, RecordMatch } from "./types.js";

/**
 * Screen a batch of employees against the stored dataset.
 * The dataset is snapshotted once, so it stays fixed for the whole run.
 * Every hit record id is returned per employee; a record may hit
 * multiple employees and duplicate records keep their own ids.
 */
export function screenEmployees(
  store: DatasetStore,
  employees: PersonInput[],
): EmployeeScreeningResult[] {
  const records = store.load();
  return employees.map((employee) => {
    const matches: RecordMatch[] = [];
    for (const record of records) {
      const category = classifyPair(employee, record);
      if (category !== null) {
        matches.push({ recordId: record.id, category });
      }
    }
    return { employeeId: employee.id, matches };
  });
}
