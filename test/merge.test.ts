import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountMergeService } from "../src/index.js";
import type { HistoryRecord } from "../src/index.js";

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "account-merge-"));
  return { dir, dbPath: join(dir, "merge.sqlite") };
}

function collectAll(
  svc: AccountMergeService,
  tenant: string,
  accountId: string,
  pageSize: number,
): HistoryRecord[] {
  const all: HistoryRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = svc.readHistory(tenant, accountId, cursor, pageSize);
    all.push(...page.records);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return all;
}

interface ExpectedRecord {
  recordId: string;
  recordedAt: string;
  sourceAccountId: string;
  body: string;
}

function sortExpected(records: ExpectedRecord[]): ExpectedRecord[] {
  return [...records].sort((a, b) => {
    const ta = Date.parse(a.recordedAt);
    const tb = Date.parse(b.recordedAt);
    if (ta !== tb) return ta - tb;
    return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
  });
}

function assertRecordsMatch(actual: HistoryRecord[], expected: ExpectedRecord[]): void {
  assert.equal(actual.length, expected.length, "record count mismatch");
  for (let i = 0; i < actual.length; i++) {
    assert.deepEqual(actual[i], expected[i], `record ${i} mismatch`);
  }
}

test("链式合并方向一：旧组整体并入新主账号，经旧编号追加历史", () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const svc = new AccountMergeService(dbPath);
    const tenant = "t1";
    for (const id of ["A", "B", "C"]) svc.createAccount(tenant, id);

    const expected: ExpectedRecord[] = [];
    const append = (accountId: string, recordId: string, recordedAt: string, body: string) => {
      svc.appendHistory({ tenantId: tenant, accountId, recordId, recordedAt, body });
      expected.push({ recordId, recordedAt, sourceAccountId: accountId, body });
    };

    append("A", "r1", "2024-01-01T00:00:00Z", "a-consent");
    append("B", "r2", "2024-01-01T00:00:00Z", "b-audit");
    append("C", "r3", "2024-01-02T00:00:00Z", "c-consent");

    // B 吸收 A，B 成为主账号
    const m1 = svc.mergeAccounts(tenant, "B", "A");
    assert.deepEqual(m1, { primaryAccountId: "B", merged: true });
    // 经旧编号 A 追加，记录进入 B 组，来源账号保留 A
    append("A", "r4", "2024-01-01T12:00:00Z", "a-after-merge");

    // C 吸收整个 B 组（用旧编号 A 指定次方），C 成为主账号
    const m2 = svc.mergeAccounts(tenant, "C", "A");
    assert.deepEqual(m2, { primaryAccountId: "C", merged: true });
    append("B", "r5", "2024-01-03T00:00:00Z", "b-after-chain");

    // 所有旧编号都指向 C
    for (const id of ["A", "B", "C"]) {
      assert.equal(svc.resolveAccount(tenant, id), "C");
    }

    // 用任意旧编号分页读取，结果与独立汇总排序一致
    for (const id of ["A", "B", "C"]) {
      const all = collectAll(svc, tenant, id, 2);
      assertRecordsMatch(all, sortExpected(expected));
    }
    svc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("链式合并方向二：当前主账号日后成为另一次合并的次账号", () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const svc = new AccountMergeService(dbPath);
    const tenant = "t1";
    for (const id of ["A", "B", "D"]) svc.createAccount(tenant, id);

    const expected: ExpectedRecord[] = [];
    const append = (accountId: string, recordId: string, recordedAt: string, body: string) => {
      svc.appendHistory({ tenantId: tenant, accountId, recordId, recordedAt, body });
      expected.push({ recordId, recordedAt, sourceAccountId: accountId, body });
    };

    append("A", "r1", "2024-02-01T00:00:00Z", "a1");
    append("B", "r2", "2024-02-01T00:00:00Z", "b1");
    append("D", "r3", "2024-02-02T00:00:00Z", "d1");

    // B 吸收 A；随后 B 自己成为 D 的次账号
    assert.deepEqual(svc.mergeAccounts(tenant, "B", "A"), {
      primaryAccountId: "B",
      merged: true,
    });
    assert.deepEqual(svc.mergeAccounts(tenant, "D", "B"), {
      primaryAccountId: "D",
      merged: true,
    });
    append("A", "r4", "2024-02-01T06:00:00Z", "a2");

    for (const id of ["A", "B", "D"]) {
      assert.equal(svc.resolveAccount(tenant, id), "D");
    }
    const all = collectAll(svc, tenant, "A", 3);
    assertRecordsMatch(all, sortExpected(expected));
    svc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同组重复合并：无效果成功，不能重新指定主账号", () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const svc = new AccountMergeService(dbPath);
    const tenant = "t1";
    for (const id of ["A", "B"]) svc.createAccount(tenant, id);

    svc.mergeAccounts(tenant, "B", "A");
    // 同组再次合并：即使把旧编号放在主方位，也不改变主账号
    const again = svc.mergeAccounts(tenant, "A", "B");
    assert.deepEqual(again, { primaryAccountId: "B", merged: false });
    const self = svc.mergeAccounts(tenant, "A", "A");
    assert.deepEqual(self, { primaryAccountId: "B", merged: false });

    assert.equal(svc.resolveAccount(tenant, "A"), "B");
    assert.equal(svc.resolveAccount(tenant, "B"), "B");
    svc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("分页读取：翻完所有页恰好得到全部记录一次，不按来源账号分组", () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const svc = new AccountMergeService(dbPath);
    const tenant = "t1";
    for (const id of ["A", "B"]) svc.createAccount(tenant, id);

    const expected: ExpectedRecord[] = [];
    // 交错来源、含相同时刻，验证 (时间, 记录编号) 排序与来源账号无关
    const inputs: Array<[string, string, string, string]> = [
      ["A", "r3", "2024-03-01T00:00:00Z", "a-first"],
      ["B", "r1", "2024-03-01T00:00:00Z", "b-first"],
      ["A", "r2", "2024-03-01T00:00:00Z", "a-second"],
      ["B", "r5", "2024-03-02T00:00:00Z", "b-later"],
      ["A", "r4", "2024-03-01T12:00:00Z", "a-noon"],
    ];
    for (const [accountId, recordId, recordedAt, body] of inputs) {
      svc.appendHistory({ tenantId: tenant, accountId, recordId, recordedAt, body });
      expected.push({ recordId, recordedAt, sourceAccountId: accountId, body });
    }
    svc.mergeAccounts(tenant, "B", "A");

    // 用页大小 1 翻页，验证不重复、不遗漏
    const seen = new Set<string>();
    let cursor: string | null = null;
    const all: HistoryRecord[] = [];
    for (;;) {
      const page = svc.readHistory(tenant, "A", cursor, 1);
      assert.ok(page.records.length <= 1);
      for (const rec of page.records) {
        assert.ok(!seen.has(rec.recordId), `duplicate record ${rec.recordId}`);
        seen.add(rec.recordId);
        all.push(rec);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assertRecordsMatch(all, sortExpected(expected));
    svc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨租户：同名账号互不影响，不能跨租户合并", () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const svc = new AccountMergeService(dbPath);
    svc.createAccount("t1", "A");
    svc.createAccount("t1", "B");
    svc.createAccount("t2", "A");
    svc.createAccount("t2", "B");

    svc.appendHistory({
      tenantId: "t1", accountId: "A", recordId: "r1",
      recordedAt: "2024-04-01T00:00:00Z", body: "t1-a",
    });
    svc.appendHistory({
      tenantId: "t2", accountId: "A", recordId: "r1",
      recordedAt: "2024-04-01T00:00:00Z", body: "t2-a",
    });

    svc.mergeAccounts("t1", "B", "A");
    // t1 的合并不影响 t2 的同名账号
    assert.equal(svc.resolveAccount("t1", "A"), "B");
    assert.equal(svc.resolveAccount("t2", "A"), "A");

    // 查询不串租户
    const t1All = collectAll(svc, "t1", "A", 10);
    assert.deepEqual(
      t1All.map((r) => r.body),
      ["t1-a"],
    );
    const t2All = collectAll(svc, "t2", "A", 10);
    assert.deepEqual(
      t2All.map((r) => r.body),
      ["t2-a"],
    );

    // 不同租户不能合并：次账号在本租户不存在
    svc.createAccount("t1", "ONLY_T1");
    assert.throws(() => svc.mergeAccounts("t2", "A", "ONLY_T1"), /unknown account/);
    svc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("正常关闭后重开：归属与历史保持一致", () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const tenant = "t1";
    const expected: ExpectedRecord[] = [];
    {
      const svc = new AccountMergeService(dbPath);
      for (const id of ["A", "B", "C"]) svc.createAccount(tenant, id);
      const append = (accountId: string, recordId: string, recordedAt: string, body: string) => {
        svc.appendHistory({ tenantId: tenant, accountId, recordId, recordedAt, body });
        expected.push({ recordId, recordedAt, sourceAccountId: accountId, body });
      };
      append("A", "r1", "2024-05-01T00:00:00Z", "a1");
      append("B", "r2", "2024-05-02T00:00:00Z", "b1");
      svc.mergeAccounts(tenant, "B", "A");
      svc.mergeAccounts(tenant, "C", "A");
      append("A", "r3", "2024-05-03T00:00:00Z", "a2");
      svc.close();
    }
    {
      const svc = new AccountMergeService(dbPath);
      for (const id of ["A", "B", "C"]) {
        assert.equal(svc.resolveAccount(tenant, id), "C");
      }
      const all = collectAll(svc, tenant, "B", 2);
      assertRecordsMatch(all, sortExpected(expected));
      // 重开后仍可经旧编号追加
      svc.appendHistory({
        tenantId: tenant, accountId: "A", recordId: "r4",
        recordedAt: "2024-05-04T00:00:00Z", body: "a3",
      });
      expected.push({
        recordId: "r4", recordedAt: "2024-05-04T00:00:00Z",
        sourceAccountId: "A", body: "a3",
      });
      assertRecordsMatch(collectAll(svc, tenant, "C", 10), sortExpected(expected));
      svc.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("错误场景：未知账号、重复记录编号、重复建号", () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const svc = new AccountMergeService(dbPath);
    svc.createAccount("t1", "A");
    assert.throws(() => svc.createAccount("t1", "A"), /already exists/);
    assert.throws(
      () =>
        svc.appendHistory({
          tenantId: "t1", accountId: "NOPE", recordId: "r1",
          recordedAt: "2024-06-01T00:00:00Z", body: "x",
        }),
      /unknown account/,
    );
    svc.appendHistory({
      tenantId: "t1", accountId: "A", recordId: "r1",
      recordedAt: "2024-06-01T00:00:00Z", body: "x",
    });
    assert.throws(
      () =>
        svc.appendHistory({
          tenantId: "t1", accountId: "A", recordId: "r1",
          recordedAt: "2024-06-02T00:00:00Z", body: "y",
        }),
      /already exists/,
    );
    assert.throws(() => svc.resolveAccount("t1", "NOPE"), /unknown account/);
    assert.throws(() => svc.mergeAccounts("t1", "A", "NOPE"), /unknown account/);
    svc.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
