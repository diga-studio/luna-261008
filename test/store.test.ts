import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RevisionStore } from '../src/index.js';
import type { AdContent, SubmitSuccess } from '../src/index.js';

function makeContent(tag: string): AdContent {
  return {
    title: `title-${tag}`,
    body: `body-${tag}`,
    cta: `cta-${tag}`,
    backgroundColor: `#${tag}`,
    font: `font-${tag}`,
  };
}

function makeStore(nowRef: { now: number }): RevisionStore {
  return new RevisionStore({ now: () => nowRef.now });
}

test('创建项目保存完整内容，初始版本号为 1', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  const content = makeContent('a');
  const created = store.createProject('p1', content);
  assert.equal(created.version, 1);
  assert.deepEqual(created.content, content);

  const current = store.getCurrent('p1');
  assert.equal(current?.version, 1);
  assert.deepEqual(current?.content, content);

  const history = store.getHistory('p1');
  assert.equal(history.length, 1);
  store.close();
});

test('首次成功提交版本号加 1，即使内容与基线完全相同', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  store.createProject('p1', makeContent('a'));
  const result = store.submitRevision('p1', 1, { title: 'title-a' });
  assert.equal(result.status, 'ok');
  assert.equal(result.version, 2);
  assert.equal(store.getCurrent('p1')?.version, 2);
  store.close();
});

test('缺失字段沿用基线修订的值', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  store.createProject('p1', makeContent('a'));
  const result = store.submitRevision('p1', 2 - 1, { title: 'new-title' }) as SubmitSuccess;
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.content, { ...makeContent('a'), title: 'new-title' });
  store.close();
});

test('同基线的完整内容与等价局部修改只新增一个修订且结果一致', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  const base = makeContent('a');
  store.createProject('p1', base);

  // 客户端甲：重新发送完整内容。
  const full: AdContent = { ...base, title: 'updated' };
  const first = store.submitRevision('p1', 1, full) as SubmitSuccess;
  assert.equal(first.status, 'ok');
  assert.equal(first.version, 2);
  assert.equal(first.deduplicated, false);

  // 客户端乙：只发送修改字段（等价局部修改）。
  const retry = store.submitRevision('p1', 1, { title: 'updated' }) as SubmitSuccess;
  assert.equal(retry.status, 'ok');
  assert.equal(retry.version, 2);
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.content, first.content);

  // 反向：先局部后完整，同样去重。
  store.createProject('p2', base);
  const partialFirst = store.submitRevision('p2', 1, { title: 'updated' }) as SubmitSuccess;
  const fullRetry = store.submitRevision('p2', 1, { ...base, title: 'updated' }) as SubmitSuccess;
  assert.equal(fullRetry.deduplicated, true);
  assert.equal(fullRetry.version, partialFirst.version);
  assert.deepEqual(fullRetry.content, partialFirst.content);

  assert.equal(store.getCurrent('p1')?.version, 2);
  assert.equal(store.getHistory('p1').length, 2);
  assert.equal(store.getCurrent('p2')?.version, 2);
  store.close();
});

test('不同内容不能互相去重；不同基线版本不能互相去重', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  store.createProject('p1', makeContent('a'));
  store.submitRevision('p1', 1, { title: 'by-user-1' });

  // 另一位用户的不同修改：不命中去重，且因基线过期而冲突。
  const other = store.submitRevision('p1', 1, { title: 'by-user-2' });
  assert.equal(other.status, 'conflict');

  // 不同基线版本：相同修改在新基线上是独立提交。
  const onNewBase = store.submitRevision('p1', 2, { title: 'by-user-1' }) as SubmitSuccess;
  assert.equal(onNewBase.status, 'ok');
  assert.equal(onNewBase.version, 3);
  assert.equal(onNewBase.deduplicated, false);
  store.close();
});

test('版本冲突不改变任何状态，失败请求不产生去重记录', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  store.createProject('p1', makeContent('a'));
  store.submitRevision('p1', 1, { title: 'v2' });

  const conflict = store.submitRevision('p1', 1, { title: 'stale' });
  assert.equal(conflict.status, 'conflict');
  assert.equal(store.getCurrent('p1')?.version, 2);
  assert.equal(store.getHistory('p1').length, 2);

  // 冲突请求不应留下去重记录：用正确基线再提相同内容，必须是新修订。
  const retry = store.submitRevision('p1', 2, { title: 'stale' }) as SubmitSuccess;
  assert.equal(retry.status, 'ok');
  assert.equal(retry.version, 3);
  assert.equal(retry.deduplicated, false);
  store.close();
});

test('去重窗口固定 5000ms：重复调用不延长，恰好 5000ms 已过期', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  store.createProject('p1', makeContent('a'));

  const first = store.submitRevision('p1', 1, { title: 'v2' }) as SubmitSuccess;
  assert.equal(first.version, 2);

  clock.now = 1000 + 4000;
  const inWindow = store.submitRevision('p1', 1, { title: 'v2' }) as SubmitSuccess;
  assert.equal(inWindow.deduplicated, true);
  assert.equal(inWindow.version, 2);

  // 窗口从首次成功起算，不因 4000ms 处的重复调用而延长。
  clock.now = 1000 + 5001;
  const afterWindow = store.submitRevision('p1', 1, { title: 'v2' });
  assert.equal(afterWindow.status, 'conflict');

  // 恰好 5000ms 时已经过期：不再命中去重，因基线过期而冲突。
  const clock2 = { now: 1000 };
  const store2 = makeStore(clock2);
  store2.createProject('p2', makeContent('a'));
  store2.submitRevision('p2', 1, { title: 'v2' });
  clock2.now = 1000 + 5000;
  const atBoundary = store2.submitRevision('p2', 1, { title: 'v2' });
  assert.equal(atBoundary.status, 'conflict');

  // 对照：4999ms 时仍在窗口内，命中去重。
  const clock3 = { now: 1000 };
  const store3 = makeStore(clock3);
  store3.createProject('p3', makeContent('a'));
  store3.submitRevision('p3', 1, { title: 'v2' });
  clock3.now = 1000 + 4999;
  const justInside = store3.submitRevision('p3', 1, { title: 'v2' }) as SubmitSuccess;
  assert.equal(justInside.status, 'ok');
  assert.equal(justInside.deduplicated, true);
  assert.equal(justInside.version, 2);

  store.close();
  store2.close();
  store3.close();
});

test('超过 20 个后续修订后，旧提交的等价重试仍返回原成功结果', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  const base = makeContent('base');
  store.createProject('p1', base);

  // 首次提交：完整内容形式。
  const targetContent: AdContent = { ...base, title: 'target-title', cta: 'target-cta' };
  const first = store.submitRevision('p1', 1, targetContent) as SubmitSuccess;
  assert.equal(first.version, 2);

  // 5 秒窗口内连续产生 21 个后续修订，把 v1、v2 挤出历史。
  for (let i = 0; i < 21; i += 1) {
    clock.now = 1000 + 100 + i;
    const current = store.getCurrent('p1');
    const result = store.submitRevision('p1', current!.version, { body: `body-${i}` });
    assert.equal(result.status, 'ok');
  }
  assert.equal(store.getCurrent('p1')?.version, 23);

  // 历史只保留最近 20 个修订（包含当前修订）。
  const history = store.getHistory('p1');
  assert.equal(history.length, 20);
  assert.equal(history[0].version, 23);
  assert.equal(history[19].version, 4);

  // 旧提交的等价重试（局部修改形式）仍返回首次成功时的版本号和完整内容。
  clock.now = 1000 + 4999;
  const retry = store.submitRevision('p1', 1, {
    title: 'target-title',
    cta: 'target-cta',
  }) as SubmitSuccess;
  assert.equal(retry.status, 'ok');
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.version, 2);
  assert.deepEqual(retry.content, targetContent);

  // 不同内容不命中去重，报版本冲突。
  const different = store.submitRevision('p1', 1, { title: 'something-else' });
  assert.equal(different.status, 'conflict');
  assert.equal((different as { currentVersion: number }).currentVersion, 23);

  // 状态未被重试改变。
  assert.equal(store.getCurrent('p1')?.version, 23);
  assert.equal(store.getHistory('p1').length, 20);
  store.close();
});

test('不能用旧内容覆盖新内容', () => {
  const clock = { now: 1000 };
  const store = makeStore(clock);
  store.createProject('p1', makeContent('a'));
  store.submitRevision('p1', 1, { title: 'new' });

  const stale = store.submitRevision('p1', 1, makeContent('a'));
  assert.equal(stale.status, 'conflict');
  assert.equal(store.getCurrent('p1')?.content.title, 'new');
  store.close();
});

test('数据持久化在 SQLite 文件中，重新打开后仍可读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-revision-store-'));
  try {
    const dbPath = join(dir, 'store.db');
    const clock = { now: 1000 };

    const writer = new RevisionStore({ dbPath, now: () => clock.now });
    writer.createProject('p1', makeContent('a'));
    writer.submitRevision('p1', 1, { title: 'persisted' });
    writer.close();

    const reader = new RevisionStore({ dbPath, now: () => clock.now });
    const current = reader.getCurrent('p1');
    assert.equal(current?.version, 2);
    assert.equal(current?.content.title, 'persisted');
    assert.equal(reader.getHistory('p1').length, 2);

    // 去重记录同样持久化：窗口未过期时重试仍命中首次成功结果。
    const retry = reader.submitRevision('p1', 1, { title: 'persisted' }) as SubmitSuccess;
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.version, 2);
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
