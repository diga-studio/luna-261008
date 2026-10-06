# SkillPulse 课表冲突引擎

TypeScript 实现的内存课表冲突引擎，串行调用、状态驻留内存，无持久化与崩溃恢复。

## 构建与测试其实我们只需要 Node.js：

```sh
npm install
npm test
```

## API

```ts
import { ScheduleEngine } from 'skillpulse-scheduler';

const engine = new ScheduleEngine();
```

- `applyScheduleBatch(changes: SessionInput[]): BatchResult`
  一次创建或替换最多 200 个场次，整批原子生效。替换保留该场次已确认学员。
  批次内 id 不得重复。按整批同时生效后的最终课表判定冲突与容量；
  任一违规则整批失败，状态保持操作前不变。
- `setEnrollment(sessionId, traineeId, enrolled): EnrollmentResult`
  加入或退出指定场次；重复加入 / 重复退出为空操作。
- `getSession(sessionId): SessionView | undefined`
  读取当前场次及已确认学员（学员按字典序的防御性拷贝）。

场次：`{ id, instructorId, venueId, start, end, capacity }`。
`start`/`end` 为整数分钟，左闭右开 `[start, end)`，长度不限；`capacity ∈ [1, 50]`。
教师、场地、学员是三个独立资源域，标识由调用方提供（非空字符串）。
非法输入（时间非整数、`start >= end`、容量越界、批次超 200、id 重复、未知场次等）直接抛错。

## 不变式

任何成功操作之后：同一教师 / 场地 / 学员不会出现在时间重叠的两个场次中；
任何场次已确认学员数不超过 `capacity`。首尾相接（`end === start`）不算重叠。

## 诊断

失败时返回完整诊断，不在第一个冲突处停止：

```ts
type BatchFailure = {
  ok: false;
  conflicts: { sessionIds: [string, string]; resources: { kind: 'instructor' | 'venue' | 'trainee'; id: string }[] }[];
  capacityViolations: { sessionId: string; capacity: number; enrolled: number }[];
};

type EnrollmentFailure = {
  ok: false;
  conflicts: { sessionId: string; start: number; end: number }[];
  capacityViolation?: { sessionId: string; capacity: number; enrolled: number };
};
```

- 批次诊断覆盖最终课表中至少一端属于本批次的所有重叠场次对；同一对场次共享多个资源时每个资源各报告一次，按 `(kind, id)` 排序、无方向性重复；容量不足的场次全部列出。
- 报名失败时报告该学员的全部时间冲突场次，以及（如存在）容量问题。

## 实现与复杂度

设 `N` = 场次数 + 报名数，`B` = 批次大小（≤200），`A` = 批次涉及场次的已有报名总数，`K` = 诊断条数。

- **索引**：每个资源（教师 / 场地 / 学员）一棵 treap，BST 键 `(start, sessionId)`，
  子树增强 `maxEnd`。插入 / 删除期望 `O(log n)`，重叠查询 `O(log n + k)`，
  只触及根到目标的路径，绝不扫描或搬移整个资源日历。
- **批量操作**：先只读地完成全部判定——批内两两判定（`B ≤ 200` 为常数上界，学员交集 ≤ 50），
  批内场次的新区间对既有索引做 `O(B + A)` 次重叠查询（跳过批内场次的旧区间，
  旧区间不参与判定）；容量检查 `O(A)`。任一违规即返回完整诊断，**状态未被触碰，天然原子**；
  全部通过后才提交，每个改动场次在三个资源域各做一次删 + 插。
  总计 `O((B + A) log(N + 1) + K)`，临时空间 `O(B + A + K)`，不复制整份状态。
- **报名操作**：一次重叠查询 + 一次插入 / 删除，`O(log(N + 1) + K)`。
- **常驻空间**：`O(N)`（场次表 + 每条教师 / 场地 / 学员关联各一个索引节点）。

## 测试

`npm test` 先编译再跑 `node --test`：

- `test/engine.test.ts`：两场次批量交换时间；交换 + 容量不足整批失败并验证无残留索引变更；
  长区间覆盖多个短区间（与未修改场次、批内场次冲突，同一对共享教师 + 场地 + 多名学员）的完整诊断集合；
  首尾相接不算重叠；报名空操作 / 冲突 / 容量 / 失败原子性；输入校验。
- `test/perf.test.ts`：10 万场次、30 万条报名，集中在 20 名教师 / 10 个场地 / 3000 名学员等热点资源上；
  造数不计时，随后 500 轮小批次调期 + 5000 次报名增删计时并打印均值
  （参考值：批均 < 0.1ms，报名均 < 0.01ms）。
