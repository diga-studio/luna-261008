# task26100889 — SkillPulse 批量排课校验组件

TypeScript 实现的内存常驻批量排课校验组件。整批新增、替换、删除按变更全部完成后的最终日程判断冲突，不自动寻找空档。

## 使用

```ts
import { SkillPulseScheduler } from "./src/scheduler";

const scheduler = new SkillPulseScheduler({
  instructors: [{ id: "instructor-a", availability: [{ start: 0, end: 10_000 }] }],
  venues: [{ id: "venue-1", capacity: 10 }],
  sessions: [], // 可选，须无冲突
});

scheduler.checkBatch(changes); // => { conflicts }，不改变当前日程
scheduler.applyBatch(changes); // 无冲突整批生效；有冲突返回报告且全部保持原样
scheduler.getSession("id");    // 读取当前场次
```

- 时间为整数毫秒，时段左闭右开，首尾相接不算重叠；教员可用时段按并集判断。
- 教员与学员容量为 1；场地负载为同场学员人数之和。
- 冲突报告按资源分别给出 `overbooked`（负载超容）与 `unavailable`（仅教员，不在可用时段内），包含资源 id、违规时间区间与涉及场次。

## 构建与测试

```sh
npm install
npm test
```
