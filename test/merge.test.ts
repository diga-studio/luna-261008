import { describe, test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountMergeStore } from "../src/index.js";
import type { HistoryRecord } from "../src/index.js";

interface SeedRecord {
  recordId: string;
  recordedAt: string;
  sourceAccountId: string;
  body: string;
}

function withStore<T>(fn: (store: AccountMergeStore, file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "merge-store-"));
  const file = join(dir, "store.sqlite");
  const store = new AccountMergeStore({ filename: file });
  try {
    return fn(store, file);
  } finally {
    try {
      store.close();
    } catch {
      // 测试内可能已关闭
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed(store: AccountMergeStore, tenant: string, records: SeedRecord[]): void {
  for (const record of records) {
    store.appendHistory({
      tenantId: tenant,
      accountId: record.sourceAccountId,
      recordId: record.recordId,
      recordedAt: record.recordedAt,
      body: record.body,
    });
  }
}

function sortExpected(records: SeedRecord[]): SeedRecord[] {
  return [...records].sort((a, b) =>
    a.recordedAt === b.recordedAt
      ? (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
      : (a.recordedAt < b.recordedAt ? -1 : 1),
  );
}

function readAll(
  store: AccountMergeStore,
  tenant: string,
  accountId: string,
  pageSize: number,
): HistoryRecord[] {
  const all: HistoryRecord[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const page = store.readHistory(tenant, accountId, { cursor, limit: pageSize });
    all.push(...page.records);
    if (page.nextCursor === null) {
      return all;
    }
    cursor = page.nextCursor;
  }
}

function toSeed(record: HistoryRecord): SeedRecord {
  return {
    recordId: record.recordId,
    recordedAt: record.recordedAt,
    sourceAccountId: record.sourceAccountId,
    body: record.body,
  };
}

const TENANT = "tenant-1";

/** 构造三个账号 a/b/c 及各自历史（含同一时刻多条记录）。 */
function baseRecords(): SeedRecord[] {
  return [
    { recordId: "r-002", recordedAt: "2026-01-01T00:00:00Z", sourceAccountId: "a", body: "a-consent" },
    { recordId: "r-001", recordedAt: "2026-01-01T00:00:00Z", sourceAccountId: "b", body: "b-consent" },
    { recordId: "r-003", recordedAt: "2026-01-02T00:00:00Z", sourceAccountId: "b", body: "b-audit" },
    { recordId: "r-004", recordedAt: "2026-01-03T00:00:00Z", sourceAccountId: "c", body: "c-consent" },
    { recordId: "r-005", recordedAt: "2026-01-03T00:00:00Z", sourceAccountId: "a", body: "a-audit" },
  ];
}

function setupThreeAccounts(store: AccountMergeStore): void {
  store.createAccount(TENANT, "a");
  store.createAccount(TENANT, "b");
  store.createAccount(TENANT, "c");
  seed(store, TENANT, baseRecords());
}

function verifyGroup(
  store: AccountMergeStore,
  expectedPrimary: string,
  oldIds: string[],
  expectedRecords: SeedRecord[],
): void {
  for (const id of oldIds) {
    equal(store.resolveAccount(TENANT, id), expectedPrimary, `resolve ${id}`);
  }
  const expected = sortExpected(expectedRecords);
  for (const id of oldIds) {
    const got = readAll(store, TENANT, id, 2).map(toSeed);
    deepEqual(got, expected, `history via ${id}`);
  }
}

describe("链式合并", () => {
  test("方向一：主账号持续吸收（a<-b，再 a<-c）", () => {
    withStore((store) => {
      setupThreeAccounts(store);
      store.mergeAccounts(TENANT, "a", "b");
      store.mergeAccounts(TENANT, "a", "c");

      // 经旧编号追加历史，进入当前账号组，来源账号保留旧编号
      const appended: SeedRecord[] = [
        { recordId: "r-006", recordedAt: "2026-01-04T00:00:00Z", sourceAccountId: "b", body: "b-late" },
        { recordId: "r-007", recordedAt: "2026-01-04T00:00:00Z", sourceAccountId: "c", body: "c-late" },
      ];
      seed(store, TENANT, appended);

      verifyGroup(store, "a", ["a", "b", "c"], [...baseRecords(), ...appended]);
    });
  });

  test("方向二：旧主账号成为次账号（a<-b，再 c<-a）", () => {
    withStore((store) => {
      setupThreeAccounts(store);
      store.mergeAccounts(TENANT, "a", "b");
      store.mergeAccounts(TENANT, "c", "a");

      const appended: SeedRecord[] = [
        { recordId: "r-006", recordedAt: "2026-01-04T00:00:00Z", sourceAccountId: "a", body: "a-late" },
        { recordId: "r-007", recordedAt: "2026-01-05T00:00:00Z", sourceAccountId: "b", body: "b-late" },
      ];
      seed(store, TENANT, appended);

      verifyGroup(store, "c", ["a", "b", "c"], [...baseRecords(), ...appended]);
    });
  });

  test("同组重复合并无效果，不能重新指定主账号", () => {
    withStore((store) => {
      setupThreeAccounts(store);
      store.mergeAccounts(TENANT, "a", "b");
      // 反向重复合并：同组，无效果成功，主账号仍是 a
      store.mergeAccounts(TENANT, "b", "a");
      store.mergeAccounts(TENANT, "a", "b");

      verifyGroup(store, "a", ["a", "b"], baseRecords().filter((r) => r.sourceAccountId !== "c"));
      // c 未参与合并，仍独立
      equal(store.resolveAccount(TENANT, "c"), "c");
    });
  });
});

describe("多租户与持久化", () => {
  test("跨租户同名账号互不影响", () => {
    withStore((store) => {
      for (const tenant of ["t1", "t2"]) {
        store.createAccount(tenant, "x");
        store.createAccount(tenant, "y");
        seed(store, tenant, [
          { recordId: "r-1", recordedAt: "2026-01-01T00:00:00Z", sourceAccountId: "x", body: `${tenant}-x` },
          { recordId: "r-2", recordedAt: "2026-01-02T00:00:00Z", sourceAccountId: "y", body: `${tenant}-y` },
        ]);
      }
      store.mergeAccounts("t1", "x", "y");

      // t1 已合并，t2 不受影响
      equal(store.resolveAccount("t1", "y"), "x");
      equal(store.resolveAccount("t2", "y"), "y");
      equal(store.resolveAccount("t2", "x"), "x");

      const t2x = readAll(store, "t2", "x", 10).map(toSeed);
      deepEqual(t2x, [
        { recordId: "r-1", recordedAt: "2026-01-01T00:00:00Z", sourceAccountId: "x", body: "t2-x" },
      ]);
      // t1 合并后整组历史归入主方
      const t1x = readAll(store, "t1", "x", 10).map(toSeed);
      deepEqual(t1x, [
        { recordId: "r-1", recordedAt: "2026-01-01T00:00:00Z", sourceAccountId: "x", body: "t1-x" },
        { recordId: "r-2", recordedAt: "2026-01-02T00:00:00Z", sourceAccountId: "y", body: "t1-y" },
      ]);
    });
  });

  test("正常关闭后重开，归属和历史保持一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-store-"));
    const file = join(dir, "store.sqlite");
    try {
      const first = new AccountMergeStore({ filename: file });
      setupThreeAccounts(first);
      first.mergeAccounts(TENANT, "a", "b");
      first.mergeAccounts(TENANT, "c", "a");
      seed(first, TENANT, [
        { recordId: "r-006", recordedAt: "2026-01-04T00:00:00Z", sourceAccountId: "b", body: "b-late" },
      ]);
      first.close();

      const second = new AccountMergeStore({ filename: file });
      try {
        verifyGroup(second, "c", ["a", "b", "c"], [
          ...baseRecords(),
          { recordId: "r-006", recordedAt: "2026-01-04T00:00:00Z", sourceAccountId: "b", body: "b-late" },
        ]);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("边界行为", () => {
  test("记录编号在租户内唯一，重复追加报错", () => {
    withStore((store) => {
      store.createAccount(TENANT, "a");
      seed(store, TENANT, [
        { recordId: "r-1", recordedAt: "2026-01-01T00:00:00Z", sourceAccountId: "a", body: "one" },
      ]);
      throws(() =>
        store.appendHistory({
          tenantId: TENANT,
          accountId: "a",
          recordId: "r-1",
          recordedAt: "2026-01-02T00:00:00Z",
          body: "dup",
        }),
      );
      // 不同租户可用相同记录编号
      store.createAccount("t2", "a");
      store.appendHistory({
        tenantId: "t2",
        accountId: "a",
        recordId: "r-1",
        recordedAt: "2026-01-02T00:00:00Z",
        body: "ok",
      });
    });
  });

  test("分页恰好遍历全部记录一次", () => {
    withStore((store) => {
      store.createAccount(TENANT, "a");
      const records: SeedRecord[] = [];
      for (let i = 0; i < 25; i += 1) {
        records.push({
          recordId: `r-${String(i).padStart(3, "0")}`,
          recordedAt: `2026-01-${String((i % 5) + 1).padStart(2, "0")}T00:00:00Z`,
          sourceAccountId: "a",
          body: `body-${i}`,
        });
      }
      seed(store, TENANT, records);
      for (const pageSize of [1, 3, 7, 25, 100]) {
        const got = readAll(store, TENANT, "a", pageSize).map(toSeed);
        deepEqual(got, sortExpected(records), `pageSize=${pageSize}`);
      }
      // 空组分页
      store.createAccount(TENANT, "empty");
      const page = store.readHistory(TENANT, "empty", { limit: 5 });
      equal(page.records.length, 0);
      equal(page.nextCursor, null);
      ok(true);
    });
  });
});
