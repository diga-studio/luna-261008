# SkillPulse 批量排课校验

内存常驻的批量排课校验组件，TypeScript 实现，零依赖（Node.js >= 22.18，利用原生类型擦除直接运行 `.ts`）。

## 使用

```ts
import { SkillPulseScheduler } from "./src/scheduler.ts";

const scheduler = new SkillPulseScheduler(
  {
    instructors: [{ id: "I1", availability: [{ start: 0, end: 10000 }] }],
    venues: [{ id: "V1", capacity: 10 }],
  },
  [], // 无冲突的初始日程
);

const conflicts = scheduler.checkBatch([
  { type: "add", session: { id: "S1", start: 0, end: 100, instructorId: "I1", venueId: "V1", traineeIds: ["T1"] } },
]);
if (conflicts.length === 0) {
  scheduler.applyBatch([/* 同一批变更 */]);
}
scheduler.getSession("S1");
```

- `checkBatch(changes)`：按整批变更全部完成后的日程返回全部冲突，不修改当前日程。
- `applyBatch(changes)`：无冲突则整批生效返回 `[]`；有冲突则返回冲突报告，日程保持原样。判定结果与批次输入顺序无关。
- `getSession(id)`：读取当前场次。

冲突分两类：`overbooked`（负载超容量，适用于教员/场地/学员）与 `unavailable`（仅教员，有课但不在可用时段并集内）。场地负载为同场学员数之和；教员与学员容量为 1。时段左闭右开，首尾相接不算重叠。

## 构建与测试

```sh
npm install
npm test
```
