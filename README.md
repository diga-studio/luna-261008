# onboarding-challenge

90 天入职挑战结算库。TypeScript 编写，挑战版本、完成记录与 XP 持久化到 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（推荐 24，`node:sqlite` 免标志可用）
- `npm install` 后 `npm test` 即可运行全部测试

## 能力

- `publishChallengeVersion({ days })`：发布挑战版本（完整 90 天、单选题），返回 `versionId`
- `getCurrentChallenge(day)`：读取当前版本某一天的挑战，携带 `versionId`
- `submitAnswer({ learnerId, day, versionId, answers, occurredAt })`：按引用的已发布版本计分；重复提交返回原完成结果且本次新增 XP 为 0
- `getProgress(learnerId)`：完成记录 + 累计 XP（基础 XP + 连续日奖励）

## 规则

- 每答对一题 10 XP，完整提交另奖 25 XP，全部答错也算完成；只有首次完成产生基础 XP
- 同一学员同一天挑战只结算一次：首次确定版本、得分、基础 XP 与活跃日期（`occurredAt` 的 UTC 自然日）
- 活跃日期划分为最大连续段，每段每满 7 天奖 50 XP，余数不跨段累计；迟到记录补齐断档后按合并后的连续段补发差额

## 示例

```ts
import { ChallengeService } from "onboarding-challenge";

const service = new ChallengeService({ dbPath: "challenge.db" }); // 缺省为内存库
const { versionId } = service.publishChallengeVersion({ days });
const challenge = service.getCurrentChallenge(1);
const result = service.submitAnswer({
  learnerId: "alice",
  day: 1,
  versionId: challenge.versionId,
  answers: [0, 2, 1],
  occurredAt: new Date(),
});
console.log(result.xpGained, service.getProgress("alice").totalXp);
service.close();
```

## 开发

```sh
npm install
npm test        # 等价于 npm run build && node --test "dist/test/*.test.js"
npm run build   # 仅编译到 dist/
```
