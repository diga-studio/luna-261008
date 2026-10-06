import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPair } from "../src/matcher.js";
import type { CriminalRecord, Employee } from "../src/types.js";

function emp(partial: Partial<Employee> & { id: string }): Employee {
  return { nameKey: "aaa", ...partial };
}

function rec(partial: Partial<CriminalRecord> & { id: string }): CriminalRecord {
  return { nameKey: "aaa", ...partial };
}

test("完整 9 位 SSN 相同为 exact，即使姓名与出生日期不同", () => {
  const category = classifyPair(
    emp({ id: "E", nameKey: "zhangsan", ssn: "123456789" }),
    rec({ id: "R", nameKey: "lisi", ssn: "123456789" }),
  );
  assert.equal(category, "exact");
});

test("出生日期冲突：双方都有但不同则不命中，即使 SSN 全等", () => {
  const category = classifyPair(
    emp({ id: "E", birthDate: "1990-01-01", ssn: "123456789" }),
    rec({ id: "R", birthDate: "1991-02-02", ssn: "123456789" }),
  );
  assert.equal(category, null);
});

test("SSN 冲突：9 位对 9 位不同则不命中", () => {
  const category = classifyPair(
    emp({ id: "E", birthDate: "1990-01-01", ssn: "123456789" }),
    rec({ id: "R", birthDate: "1990-01-01", ssn: "123456780" }),
  );
  assert.equal(category, null);
});

test("SSN 冲突：9 位对末 4 位，对应尾位不同则不命中", () => {
  const category = classifyPair(
    emp({ id: "E", birthDate: "1990-01-01", ssn: "123456789" }),
    rec({ id: "R", birthDate: "1990-01-01", ssn: "6780" }),
  );
  assert.equal(category, null);
});

test("SSN 末 4 位一致不构成 exact，只能按其他证据分类", () => {
  const category = classifyPair(
    emp({ id: "E", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" }),
    rec({ id: "R", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "6789" }),
  );
  assert.equal(category, "partial");
});

test("出生日期相同且姓名键全等为 partial", () => {
  const category = classifyPair(
    emp({ id: "E", nameKey: "zhangsan", birthDate: "1990-01-01" }),
    rec({ id: "R", nameKey: "zhangsan", birthDate: "1990-01-01" }),
  );
  assert.equal(category, "partial");
});

test("出生日期相同且姓名编辑距离不超过 2 为 fuzzy", () => {
  const category = classifyPair(
    emp({ id: "E", nameKey: "zhangsna", birthDate: "1990-01-01" }),
    rec({ id: "R", nameKey: "zhangsan", birthDate: "1990-01-01" }),
  );
  assert.equal(category, "fuzzy");
});

test("姓名编辑距离超过 2 不命中", () => {
  const category = classifyPair(
    emp({ id: "E", nameKey: "zhxxxsan", birthDate: "1990-01-01" }),
    rec({ id: "R", nameKey: "zhangsan", birthDate: "1990-01-01" }),
  );
  assert.equal(category, null);
});

test("缺失出生日期：既不冲突也不能支撑 partial/fuzzy", () => {
  assert.equal(
    classifyPair(
      emp({ id: "E", nameKey: "zhangsan" }),
      rec({ id: "R", nameKey: "zhangsan", birthDate: "1990-01-01" }),
    ),
    null,
  );
  assert.equal(
    classifyPair(
      emp({ id: "E", nameKey: "zhangsan", birthDate: "1990-01-01" }),
      rec({ id: "R", nameKey: "zhangsan" }),
    ),
    null,
  );
});

test("缺失 SSN：不构成冲突，也不能支撑 exact", () => {
  const category = classifyPair(
    emp({ id: "E", nameKey: "zhangsan", birthDate: "1990-01-01" }),
    rec({ id: "R", nameKey: "zhangsan", birthDate: "1990-01-01", ssn: "123456789" }),
  );
  assert.equal(category, "partial");
});

test("SSN 末 4 位相同但无其他证据时不命中", () => {
  const category = classifyPair(
    emp({ id: "E", nameKey: "zhangsan", ssn: "6789" }),
    rec({ id: "R", nameKey: "lisi", ssn: "123456789" }),
  );
  assert.equal(category, null);
});
