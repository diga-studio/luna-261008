# ad-revision-store

广告项目的修订提交库（TypeScript + SQLite），由上层创意编辑器直接调用。

## 能力

- `createProject(content)`：创建项目，保存完整内容（标题、正文、CTA、背景色、字体，均为字符串），初始版本号 1。
- `submitChange(projectId, baseVersion, patch)`：携带基线版本号与任意非空字段子集提交修改。
- `getCurrent(projectId)` / `getHistory(projectId)`：查看当前内容与修订历史（最近 20 个完整修订，含当前）。

## 使用

```ts
import { RevisionStore } from 'ad-revision-store';

const store = new RevisionStore('ads.db');
const p = store.createProject({
  title: '夏季大促', body: '全场五折起', cta: '立即抢购',
  backgroundColor: '#FF5500', font: 'PingFang SC',
});

const r = store.submitChange(p.projectId, 1, { title: '新标题' });
if (r.status === 'ok') {
  // r.version 为归属版本号；r.deduplicated === true 表示命中去重、未新增修订
} else {
  // r.status === 'conflict'，以 r.currentVersion 为基线重试
}
```

## 并发与重试语义

- 缺失字段按**基线修订**的值补全，补全后的完整内容决定提交身份；字段次序无关，
  完整内容与等价的局部修改互相去重，不同基线版本互不去重。
- 首次成功提交版本号必加 1（即使内容与基线相同）。首次成功后开启固定 5000ms 去重窗口：
  窗口内同一逻辑提交返回首次成功的版本号与完整内容，不新增修订；重复调用不延长窗口；
  距首次成功恰好 5000ms 时窗口已过期。
- 有效去重优先于版本冲突判断；未命中去重时仅当基线等于当前版本才成功，否则返回冲突且不改状态；
  失败请求不产生去重记录。
- 去重记录持久化在 SQLite 中并保存首次成功的完整结果，因此即使对应修订已被挤出对外历史
  （对外仅保留最近 20 个），窗口未过期的等价重试仍返回原成功结果。
- 修订行在库内完整保留（用于基线补全与去重判定），`getHistory` 只暴露最近 20 个。

## 构建与测试

要求 Node.js >= 22.13（使用内置 `node:sqlite`，无需任何原生模块或外部服务）。

```sh
npm install
npm test        # 编译 src 与 test 后运行 node:test
npm run build   # 仅编译库到 dist/
```
