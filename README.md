# ad-revision-store

广告项目的修订提交库（TypeScript + SQLite），由上层创意编辑器直接调用。

## 能力

- `createProject(projectId, content)` — 创建项目，保存完整内容，初始版本号 1。
- `submitRevision(projectId, baseVersion, patch)` — 提交修改（任意非空字段子集，缺失字段沿用基线值）。
- `getCurrent(projectId)` / `getHistory(projectId)` — 查看当前内容与最近 20 个完整修订。

## 使用

```ts
import { RevisionStore } from 'ad-revision-store';

const store = new RevisionStore({ dbPath: 'ads.db' }); // 省略 dbPath 则使用内存库
store.createProject('proj-1', {
  title: '标题', body: '正文', cta: '立即购买', backgroundColor: '#fff', font: 'sans',
});
const result = store.submitRevision('proj-1', 1, { title: '新标题' });
// result: { status: 'ok', version: 2, content: {...}, deduplicated: false }
//      或 { status: 'conflict', currentVersion: n }
```

## 并发与重试语义

- 两次修改属于同一逻辑提交，当且仅当项目、基线版本号、补全缺失字段后的完整内容都相同。
- 首次成功后开启固定 5000ms 去重窗口：窗口内等价重试返回首次成功的版本号与完整内容，不新增修订；重复调用不延长窗口；恰好 5000ms 时已过期。
- 有效去重优先于版本冲突判断；未命中去重时，基线版本必须等于当前版本，否则返回冲突且不改状态。
- 去重记录独立保存首次成功的完整结果，即使对应修订已被挤出最近 20 条历史，窗口内重试仍返回原结果。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>= 22.5，使用内置 `node:sqlite`）与 devDependencies 中的 `typescript`、`@types/node`。
