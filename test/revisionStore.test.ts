import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RevisionStore } from '../src/index';
import { AdContent, SubmitSuccess } from '../src/types';

const BASE: AdContent = {
  title: '夏季大促',
  body: '全场五折起',
  cta: '立即抢购',
  backgroundColor: '#FF5500',
  font: 'PingFang SC',
};

function makeClock(start = 1_000_000) {
  const state = { t: start };
  return {
    now: () => state.t,
    advance(ms: number) {
      state.t += ms;
    },
  };
}

function makeStore(dbPath = ':memory:', clock = makeClock()) {
  const store = new RevisionStore(dbPath, { now: clock.now });
  return { store, clock };
}

function ok(result: unknown): SubmitSuccess {
  assert.equal((result as { status: string }).status, 'ok');
  return result as SubmitSuccess;
}

test('创建项目：保存完整内容，初始版本号为 1', () => {
  const { store } = makeStore();
  const p = store.createProject(BASE);
  assert.equal(p.version, 1);
  assert.deepEqual(p.content, BASE);
  assert.deepEqual(store.getCurrent(p.projectId), { projectId: p.projectId, version: 1, content: BASE });
  const history = store.getHistory(p.projectId);
  assert.equal(history.length, 1);
  assert.equal(history[0].version, 1);
  store.close();
});

test('同基线的完整内容与等价局部修改互相去重，只新增一个修订', () => {
  const { store } = makeStore();
  const p = store.createProject(BASE);

  // 客户端 A：网络重试发送完整内容（字段次序不同也不影响身份）。
  const full = {
    font: 'PingFang SC',
    backgroundColor: '#FF5500',
    cta: '马上抢',
    body: '全场五折起',
    title: '夏季大促·终场',
  };
  const r1 = ok(store.submitChange(p.projectId, 1, full));
  assert.equal(r1.version, 2);
  assert.equal(r1.deduplicated, false);

  // 客户端 B：只发送修改字段，缺失字段由基线补全后与 A 完全等价。
  const r2 = ok(store.submitChange(p.projectId, 1, { title: '夏季大促·终场', cta: '马上抢' }));
  assert.equal(r2.deduplicated, true);
  assert.equal(r2.version, r1.version);
  assert.deepEqual(r2.content, r1.content);

  // 只新增了一个修订；补全用的是基线值而非最新值。
  assert.equal(store.getCurrent(p.projectId).version, 2);
  assert.equal(store.getHistory(p.projectId).length, 2);
  assert.equal(r2.content.font, BASE.font);
  store.close();
});

test('首次成功提交即使内容与基线完全相同，版本号也加 1', () => {
  const { store } = makeStore();
  const p = store.createProject(BASE);
  const r = ok(store.submitChange(p.projectId, 1, { title: BASE.title }));
  assert.equal(r.version, 2);
  assert.deepEqual(r.content, BASE);
  store.close();
});

test('不同基线版本不能互相去重；未命中去重且基线落后时冲突且不改状态', () => {
  const { store } = makeStore();
  const p = store.createProject(BASE);
  ok(store.submitChange(p.projectId, 1, { title: 'V2' }));

  // 相同内容、不同基线：不去重，且基线 != 当前版本 -> 冲突。
  const conflict = store.submitChange(p.projectId, 1, { title: 'V2' });
  // 注意：上面这次与首次成功同基线同内容，应命中去重。
  assert.equal(conflict.status, 'ok');

  // 真正不同基线：把同样内容基于版本 2 再提交（版本 2 已是当前）。
  const r = ok(store.submitChange(p.projectId, 2, { title: 'V2' }));
  assert.equal(r.version, 3);
  assert.equal(r.deduplicated, false);

  // 基线落后、内容也未命中去重 -> 冲突，状态不变。
  const c2 = store.submitChange(p.projectId, 1, { title: 'V2-again' });
  assert.deepEqual(c2, { status: 'conflict', currentVersion: 3 });
  assert.equal(store.getCurrent(p.projectId).version, 3);
  assert.equal(store.getHistory(p.projectId).length, 3);
  store.close();
});

test('失败请求不产生去重记录', () => {
  const { store } = makeStore();
  const p = store.createProject(BASE);

  // 基线 2 尚不存在 -> 冲突（失败），不应留下去重记录。
  const early = store.submitChange(p.projectId, 2, { title: '将来' });
  assert.equal(early.status, 'conflict');

  ok(store.submitChange(p.projectId, 1, { body: '新正文' })); // 当前版本变为 2

  // 同样的提交现在应作为首次成功产生新版本，而不是被之前的失败“去重”。
  const r = ok(store.submitChange(p.projectId, 2, { title: '将来' }));
  assert.equal(r.version, 3);
  assert.equal(r.deduplicated, false);
  store.close();
});

test('去重窗口固定 5000ms：重复调用不延长，恰好 5000ms 时已过期', () => {
  const clock = makeClock();
  const { store } = makeStore(':memory:', clock);
  const p = store.createProject(BASE);

  const r1 = ok(store.submitChange(p.projectId, 1, { title: '限时' }));
  clock.advance(4000);
  const r2 = ok(store.submitChange(p.projectId, 1, { title: '限时' }));
  assert.equal(r2.deduplicated, true);
  assert.equal(r2.version, r1.version);

  // 再推进 999ms：距首次成功 4999ms，仍在窗口内（窗口不因 r2 延长）。
  clock.advance(999);
  const r3 = ok(store.submitChange(p.projectId, 1, { title: '限时' }));
  assert.equal(r3.deduplicated, true);

  // 恰好 5000ms：已过期。基线 1 != 当前 2，且去重失效 -> 冲突。
  clock.advance(1);
  const expired = store.submitChange(p.projectId, 1, { title: '限时' });
  assert.deepEqual(expired, { status: 'conflict', currentVersion: 2 });
  store.close();
});

test('超过 20 个后续修订后：旧重试仍返回原成功结果，不同内容报冲突，历史仅 20 条', () => {
  const clock = makeClock();
  const { store } = makeStore(':memory:', clock);
  const p = store.createProject(BASE);

  // 首次提交：基线 1，局部修改。
  const first = ok(store.submitChange(p.projectId, 1, { title: '首版标题' }));
  assert.equal(first.version, 2);

  // 5 秒内连续产生 21 个后续修订，把基线 1 和结果 2 都挤出对外历史。
  for (let i = 0; i < 21; i++) {
    clock.advance(100); // 总计 2100ms，窗口未过期
    const cur = store.getCurrent(p.projectId).version;
    ok(store.submitChange(p.projectId, cur, { body: `正文 ${i}` }));
  }
  assert.equal(store.getCurrent(p.projectId).version, 23);

  // 历史只显示最近 20 个修订（版本 4..23）。
  const history = store.getHistory(p.projectId);
  assert.equal(history.length, 20);
  assert.equal(history[0].version, 4);
  assert.equal(history[19].version, 23);

  // 旧提交的等价重试（完整内容形态）仍返回首次成功的版本与内容。
  const retry = ok(
    store.submitChange(p.projectId, 1, {
      title: '首版标题',
      body: BASE.body,
      cta: BASE.cta,
      backgroundColor: BASE.backgroundColor,
      font: BASE.font,
    }),
  );
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.version, 2);
  assert.deepEqual(retry.content, first.content);
  assert.equal(store.getCurrent(p.projectId).version, 23); // 未新增修订

  // 同基线但不同内容：不命中去重 -> 冲突。
  const other = store.submitChange(p.projectId, 1, { title: '别的标题' });
  assert.deepEqual(other, { status: 'conflict', currentVersion: 23 });
  store.close();
});

test('数据持久化在 SQLite：重新打开后当前内容与历史保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-rev-'));
  try {
    const file = join(dir, 'data.db');
    const s1 = new RevisionStore(file);
    const p = s1.createProject(BASE);
    ok(s1.submitChange(p.projectId, 1, { title: '第二版' }));
    s1.close();

    const s2 = new RevisionStore(file);
    assert.equal(s2.getCurrent(p.projectId).version, 2);
    assert.equal(s2.getCurrent(p.projectId).content.title, '第二版');
    assert.equal(s2.getHistory(p.projectId).length, 2);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('非法输入：空 patch、非字符串字段、未知项目', () => {
  const { store } = makeStore();
  const p = store.createProject(BASE);
  assert.throws(() => store.submitChange(p.projectId, 1, {}), TypeError);
  assert.throws(() => store.submitChange(p.projectId, 1, { title: 1 as unknown as string }), TypeError);
  assert.throws(() => store.submitChange(p.projectId, 0, { title: 'x' }), TypeError);
  assert.throws(() => store.submitChange('no-such-project', 1, { title: 'x' }), /项目不存在/);
  assert.throws(() => store.getCurrent('no-such-project'), /项目不存在/);
  store.close();
});

test('同一基线的不同内容互不去重：后者作为新提交成功', () => {
  const clock = makeClock();
  const { store } = makeStore(':memory:', clock);
  const p = store.createProject(BASE);

  const r1 = ok(store.submitChange(p.projectId, 1, { title: '甲的标题' }));
  assert.equal(r1.version, 2);

  // 另一位用户基于同一基线提交不同内容：不是重试，但基线已落后 -> 冲突。
  const other = store.submitChange(p.projectId, 1, { title: '乙的标题' });
  assert.deepEqual(other, { status: 'conflict', currentVersion: 2 });

  // 乙基于最新版本重新提交：正常成功，不受甲的去重记录影响。
  const r2 = ok(store.submitChange(p.projectId, 2, { title: '乙的标题' }));
  assert.equal(r2.version, 3);
  assert.equal(r2.deduplicated, false);
  assert.equal(store.getCurrent(p.projectId).content.title, '乙的标题');
  store.close();
});
