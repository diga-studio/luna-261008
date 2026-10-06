import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance } from "../src/editDistance.js";

test("空串与相等串", () => {
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("abc", ""), 3);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("zhangsan", "zhangsan"), 0);
});

test("单字符替换、插入、删除各计 1", () => {
  assert.equal(editDistance("zhangsan", "zhangsen"), 1);
  assert.equal(editDistance("zhangsan", "zhangsann"), 1);
  assert.equal(editDistance("zhangsan", "zhangsn"), 1);
});

test("插入加删除造成的两次修改计 2", () => {
  assert.equal(editDistance("zhangsan", "zhangsna"), 2);
});

test("交换相邻字符不算一次修改（计 2）", () => {
  assert.equal(editDistance("ab", "ba"), 2);
});

test("max 截断：超过 max 时返回值大于 max", () => {
  assert.ok(editDistance("zhangsan", "zhangsna", 1) > 1);
  assert.equal(editDistance("zhangsan", "zhangsna", 2), 2);
  assert.ok(editDistance("abc", "xyz", 2) > 2);
});
