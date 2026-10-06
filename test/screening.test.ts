import { test } from "node:test";
import assert from "node:assert/strict";
import { screenEmployees } from "../src/screening.js";
import type { CriminalRecord, Employee, EmployeeScreenResult } from "../src/types.js";

// 小规模混合数据集：
// R1/R2 为同名（zhangsan）不同标识的两条刑录；R3/R6 同名（lisi）；
// R4 缺出生日期；R5 用于制造强标识冲突。
const DATASET: CriminalRecord[] = [
  { id: "R1", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" },
  { id: "R2", nameKey: "zhangsan", birthDate: "1990-01-01" },
  { id: "R3", nameKey: "lisi", birthDate: "1985-05-20", ssn: "4321" },
  { id: "R4", nameKey: "wangwu", ssn: "987654321" },
  { id: "R5", nameKey: "zhaoliu", birthDate: "1992-03-03", ssn: "111110000" },
  { id: "R6", nameKey: "lisi", birthDate: "1985-05-20", ssn: "999994321" },
];

const EMPLOYEES: Employee[] = [
  // E1：与 R1 全等 SSN -> exact；与 R2 同名同生日 -> partial；
  // 与 R4/R5/R6 均存在强标识冲突。
  { id: "E1", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" },
  // E2：姓名经一次插入加一次删除（zhangsan -> zhangsna，距离 2）-> fuzzy。
  { id: "E2", nameKey: "zhangsna", birthDate: "1990-01-01" },
  // E3：缺出生日期，仅凭完整 SSN 命中 R6；与 R3 末 4 位一致但无其他证据，不命中。
  { id: "E3", nameKey: "lisi", ssn: "999994321" },
  // E4：与 E1 同时命中 R1/R2（同一刑录可命中多位员工）。
  { id: "E4", nameKey: "zhangsan", birthDate: "1990-01-01" },
  // E5：姓名距离 3，不命中任何记录。
  { id: "E5", nameKey: "zhxxxsan", birthDate: "1990-01-01" },
];

const EXPECTED: EmployeeScreenResult[] = [
  {
    employeeId: "E1",
    hits: [
      { recordId: "R1", category: "exact" },
      { recordId: "R2", category: "partial" },
    ],
  },
  {
    employeeId: "E2",
    hits: [
      { recordId: "R1", category: "fuzzy" },
      { recordId: "R2", category: "fuzzy" },
    ],
  },
  { employeeId: "E3", hits: [{ recordId: "R6", category: "exact" }] },
  {
    employeeId: "E4",
    hits: [
      { recordId: "R1", category: "partial" },
      { recordId: "R2", category: "partial" },
    ],
  },
  { employeeId: "E5", hits: [] },
];

test("混合数据集的全部命中及类别完全正确", () => {
  assert.deepEqual(screenEmployees(EMPLOYEES, DATASET), EXPECTED);
});

test("每位员工都返回结果，无命中时 hits 为空数组", () => {
  const results = screenEmployees(EMPLOYEES, DATASET);
  assert.equal(results.length, EMPLOYEES.length);
  assert.deepEqual(
    results.map((r) => r.employeeId),
    EMPLOYEES.map((e) => e.id),
  );
});

test("同一配对只取最高类别（exact 不重复报 partial/fuzzy）", () => {
  const results = screenEmployees(
    [{ id: "E", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" }],
    [{ id: "R", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" }],
  );
  assert.deepEqual(results[0]?.hits, [{ recordId: "R", category: "exact" }]);
});

test("字段相同但标识不同的刑录分别保留", () => {
  const results = screenEmployees(
    [{ id: "E", nameKey: "zhangsan", birthDate: "1990-01-01" }],
    [
      { id: "RA", nameKey: "zhangsan", birthDate: "1990-01-01" },
      { id: "RB", nameKey: "zhangsan", birthDate: "1990-01-01" },
    ],
  );
  assert.deepEqual(results[0]?.hits, [
    { recordId: "RA", category: "partial" },
    { recordId: "RB", category: "partial" },
  ]);
});

test("空数据集与空员工列表", () => {
  assert.deepEqual(screenEmployees(EMPLOYEES, []), 
    EMPLOYEES.map((e) => ({ employeeId: e.id, hits: [] })));
  assert.deepEqual(screenEmployees([], DATASET), []);
});
